import { writable, type Writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import CryptoJS from 'crypto-js';

// JavaScript logging utility that sends logs to Rust terminal
const jsLog = {
	info: (message: string) => invoke('js_log', { level: 'info', message }),
	error: (message: string) => invoke('js_log', { level: 'error', message }),
	debug: (message: string) => invoke('js_log', { level: 'debug', message }),
};

interface Auth0Config {
	domain: string;
	clientId: string;
	audience: string;
	scope: string;
	useCustomProtocol: boolean;
}

interface Auth0User {
	sub: string;
	name?: string;
	email?: string;
	picture?: string;
	[key: string]: unknown;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	token_type: string;
	expires_in: number;
}

type TokenGrant =
	| { grant_type: 'authorization_code'; code: string; code_verifier: string }
	| { grant_type: 'refresh_token'; refresh_token: string };

class Auth0Service {
	private initialization: Promise<void>;
	private config: Auth0Config;
	private codeVerifier: string | null = null;
	private callbackPort = 3000;
	private cachedTokens: (TokenResponse & { expiration_time?: number }) | null =
		null;
	private signInRequired = false;

	// Svelte stores for reactive state
	public isLoading: Writable<boolean> = writable(false);
	public isAuthenticated: Writable<boolean> = writable(false);
	public user: Writable<Auth0User | null> = writable(null);
	public error: Writable<string | null> = writable(null);
	public accessToken: Writable<string | null> = writable(null);
	public sessionChecking = writable(true);

	constructor() {
		this.config = {
			domain: 'dev-v6bfenyhz8m15z6j.eu.auth0.com',
			clientId: 'Nobjj5cwIKiVfUP2iSfIVVRuouNUqlno',
			audience: 'https://whisperme.app/api',
			scope: 'openid profile email offline_access',
			useCustomProtocol: true, // Back to custom protocol for debugging
		};

		this.initialization = this.initialize().finally(() => {
			if (!this.voicePreflight) this.sessionChecking.set(false);
		});
	}

	public localTest = writable(false);
	private localMode = false;
	private voicePreflight: Promise<string | null> | undefined;
	public async getVoiceAccessToken(
		forceRefresh = false,
	): Promise<string | null> {
		if (!this.voicePreflight) {
			this.voicePreflight = this.preflightVoiceSession(forceRefresh).finally(() => {
				this.voicePreflight = undefined;
				this.sessionChecking.set(false);
			});
		}
		return this.voicePreflight;
	}

	public async checkVoiceSession(): Promise<boolean> {
		return (await this.getVoiceAccessToken()) !== null;
	}

	private async boundedVoiceRequest<T>(request: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				request,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('Voice preflight timed out')), 5000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async preflightVoiceSession(forceRefresh: boolean): Promise<string | null> {
		try {
			await this.initialization;
			// Recheck the native session: a local launcher credential may have expired.
			if (await this.boundedVoiceRequest(invoke<boolean>('voice_local_mode')))
				return 'local-native-session';
			if (this.localMode) throw new Error('Local session unavailable');
			// Load lazily: settings -> toast -> services can lead back to auth0.
			const { settings } = await import('$lib/stores/settings.svelte');
			const endpoint = settings.value['voiceInput.endpoint'];
			let token = forceRefresh ? await this.refreshToken() : await this.getAccessToken();
			if (!token) return null;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await this.boundedVoiceRequest(invoke('voice_backend_status', { endpoint, token }));
					// A logout or endpoint change during the request invalidates its result.
					if (this.cachedTokens?.access_token !== token ||
						settings.value['voiceInput.endpoint'] !== endpoint) {
						throw new Error('Session changed during preflight');
					}
					this.error.set(null);
					return token;
				} catch (error) {
					if (this.cachedTokens?.access_token !== token ||
						settings.value['voiceInput.endpoint'] !== endpoint) throw error;
					// Match the native command's status-only error, never arbitrary response text.
					if (!/^Backend returned 401(?:\s|$)/.test(String(error))) throw error;
					if (attempt === 1 || forceRefresh) {
						await this.clearStoredTokens();
						this.requireSignIn();
						return null;
					}
					token = await this.refreshToken();
					if (!token) return null;
				}
			}
		} catch {
			// Native errors can contain URLs; do not log or surface them with credentials.
			this.error.set('Could not verify your voice session. Check your connection and retry before recording.');
		}
		return null;
	}

	private async initialize() {
		try {
			this.localMode = await invoke<boolean>('voice_local_mode');
			if (this.localMode) {
				this.localTest.set(true);
				this.isAuthenticated.set(true);
				this.user.set({ sub: 'local-test', name: 'Local test session' });
				return;
			}
		} catch {
			/* Missing or expired local session stays signed out. */
		}

		// Check if we have stored tokens
		await this.loadStoredTokens();
	}

	private async loadStoredTokens() {
		if (this.signInRequired) return;
		try {
			const stored = await invoke<string | null>('get_stored_tokens');
			if (stored) {
				const tokens = JSON.parse(stored);
				this.cachedTokens = tokens;

				if (tokens.access_token) {
					const expirationTime = tokens.expiration_time as number | undefined;
					if (!expirationTime || Date.now() >= expirationTime - 60_000) {
						await this.refreshToken();
						return;
					}

					await this.applyTokenState(tokens);
				}
			}
		} catch (error) {
			this.error.set('Could not check your saved session. Please retry before recording.');
		}
	}

	public async checkSession(): Promise<boolean> {
		this.sessionChecking.set(true);
		try {
			return await this.checkVoiceSession();
		} finally {
			this.sessionChecking.set(false);
		}
	}

	private requireSignIn() {
		this.signInRequired = true;
		this.cachedTokens = null;
		this.isAuthenticated.set(false);
		this.accessToken.set(null);
		this.user.set(null);
		this.error.set('Your session has expired. Please sign in before recording.');
	}

	private async storeTokens(
		tokens: TokenResponse & { expiration_time?: number },
	) {
		try {
			this.cachedTokens = tokens;
			await invoke('store_tokens', { tokens: JSON.stringify(tokens) });
		} catch (error) {
			console.error('Failed to store tokens:', error);
		}
	}

	private async clearStoredTokens() {
		try {
			this.cachedTokens = null;
			await invoke('clear_stored_tokens');
		} catch (error) {
			console.error('Failed to clear tokens:', error);
		}
	}

	private generateCodeVerifier(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode.apply(null, Array.from(array)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=/g, '');
	}

	private generateCodeChallenge(verifier: string): string {
		const hash = CryptoJS.SHA256(verifier);
		return CryptoJS.enc.Base64url.stringify(hash);
	}

	private generateRandomString(length: number): string {
		const possible =
			'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let text = '';
		for (let i = 0; i < length; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	private decodeIdToken(token: string): Auth0User | null {
		try {
			const parts = token.split('.');
			if (parts.length < 2) {
				return null;
			}

			const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
			const padLength = (4 - (base64.length % 4)) % 4;
			const padded = base64 + '='.repeat(padLength);
			const decoded = atob(padded);
			const payload = JSON.parse(decoded);

			return {
				sub: payload.sub,
				name: payload.name,
				email: payload.email,
				picture: payload.picture,
				...payload,
			};
		} catch (error) {
			console.error('Failed to decode ID token:', error);
			return null;
		}
	}

	private async fetchUserInfoWithAccessToken(
		accessToken: string,
	): Promise<Auth0User | null> {
		try {
			const userInfoUrl = `https://${this.config.domain}/userinfo`;

			const response = await tauriFetch(userInfoUrl, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			});

			if (!response.ok) {
				jsLog.error(
					`User info request failed: ${response.status} ${response.statusText}`,
				);
				return null;
			}

			const userInfo: Auth0User = await response.json();

			return userInfo;
		} catch (error) {
			jsLog.error('=== USER INFO ERROR ===');
			jsLog.error(`Failed to get user info: ${error}`);
			jsLog.error(
				`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
			jsLog.error(
				`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
			);
			return null;
		}
	}

	private async applyTokenState(
		tokens: TokenResponse & { expiration_time?: number },
	) {
		this.signInRequired = false;
		this.accessToken.set(tokens.access_token);
		this.cachedTokens = tokens;

		let userInfo: Auth0User | null = null;
		if (tokens.id_token) {
			userInfo = this.decodeIdToken(tokens.id_token);
		}

		if (!userInfo) {
			userInfo = await this.fetchUserInfoWithAccessToken(tokens.access_token);
		}

		if (userInfo) {
			this.user.set(userInfo);
		} else {
			let existingUser: Auth0User | null = null;
			const unsubscribe = this.user.subscribe((value) => {
				existingUser = value;
			});
			unsubscribe();
			if (!existingUser) {
				this.user.set({ sub: 'unknown' });
			}
		}

		this.isAuthenticated.set(true);
		this.error.set(null);
	}

	public async login() {
		try {
			this.isLoading.set(true);
			this.error.set(null);

			// Generate PKCE parameters
			this.codeVerifier = this.generateCodeVerifier();
			const codeChallenge = this.generateCodeChallenge(this.codeVerifier);
			const state = this.generateRandomString(32);

			// Store state and code verifier for later verification
			sessionStorage.setItem('auth0_state', state);
			sessionStorage.setItem('auth0_code_verifier', this.codeVerifier);

			// Build authorization URL - use localhost for Firefox compatibility
			const browserRedirectUri = `http://localhost:${this.callbackPort}/callback`;

			const params = new URLSearchParams({
				response_type: 'code',
				client_id: this.config.clientId,
				redirect_uri: browserRedirectUri, // Always use localhost for browser compatibility
				scope: this.config.scope,
				state: state,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
			});

			// Remove the double encoding attempt
			// URLSearchParams already handles encoding correctly

			// Only add audience if it's configured
			if (this.config.audience) {
				params.set('audience', this.config.audience);
			}

			const authUrl = `https://${this.config.domain}/authorize?${params.toString()}`;

			// Remove the Firefox workaround attempt

			// Always start local server for browser compatibility

			await this.startCallbackServer();

			// Start polling for callback data from local server

			this.pollForCallback();

			// Open browser for authentication

			// Show URL for debugging

			try {
				await open(authUrl);
			} catch (openError) {
				console.error('Error opening browser:', openError);

				// Firefox fallback: try opening with Windows command
				if (process.platform === 'win32') {
					try {
						const { Command } = await import('@tauri-apps/plugin-shell');
						await Command.create('cmd', ['/c', 'start', '', authUrl]).execute();
					} catch (fallbackError) {
						console.error('Windows command fallback failed:', fallbackError);
						throw openError;
					}
				} else {
					throw openError;
				}
			}
		} catch (error) {
			console.error('Login error:', error);
			this.error.set(error instanceof Error ? error.message : 'Login failed');
			this.isLoading.set(false);
		}
	}

	private async setupDeepLinkListener() {
		try {
			// Listen for deep link events from the plugin
			const { listen } = await import('@tauri-apps/api/event');

			await listen('deep-link', (event) => {
				// Handle the deep link URL directly
				this.handleDeepLinkUrl(event.payload as string);
			});

			// Also start polling as backup
			this.pollForCallback();
		} catch (error) {
			console.error('Failed to setup deep link listener:', error);
			// Fallback to polling only
			this.pollForCallback();
		}
	}

	private async handleDeepLinkUrl(url: string) {
		try {
			const urlObj = new URL(url);
			if (
				urlObj.protocol === 'whisperme:' &&
				urlObj.pathname === '/auth/callback'
			) {
				const params = new URLSearchParams(urlObj.search);
				const callbackData = {
					code: params.get('code') || undefined,
					state: params.get('state') || undefined,
					error: params.get('error') || undefined,
				};

				await this.handleAuthCallback(callbackData);
			}
		} catch (error) {
			console.error('Failed to handle deep link URL:', error);
		}
	}

	private async startCallbackServer() {
		try {
			// Start HTTP server on Rust side to handle OAuth callback
			await invoke('start_oauth_server', { port: this.callbackPort });

			// Don't start polling here - it should be started separately
			// jsLog.info('About to start polling...');
			// this.pollForCallback();
			// jsLog.info('Polling started');
		} catch (error) {
			jsLog.error('=== CALLBACK SERVER START FAILED ===');
			jsLog.error(`Failed to start callback server: ${error}`);
			throw new Error('Failed to start authentication server');
		}
	}

	private async pollForCallback() {
		const maxAttempts = 300; // 5 minutes at 1 second intervals
		let attempts = 0;

		const poll = async () => {
			try {
				attempts++;

				let callbackDataString: string | null = null;
				try {
					callbackDataString = await invoke<string | null>(
						'get_oauth_callback',
					);

					if (callbackDataString) {
						try {
							const callbackData = JSON.parse(callbackDataString);

							await this.handleAuthCallback(callbackData);
						} catch (parseError) {
							jsLog.error('=== JSON PARSE ERROR ===');
							jsLog.error('Invalid OAuth callback JSON');
							this.error.set(
								`Failed to parse callback data: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
							);
							this.isLoading.set(false);
						}
						return;
					}
				} catch (invokeError) {
					jsLog.error('=== INVOKE ERROR ===');
					jsLog.error(`invoke get_oauth_callback failed: ${invokeError}`);
					throw invokeError;
				}

				if (attempts >= maxAttempts) {
					jsLog.error(`Authentication timeout after ${maxAttempts} attempts`);
					this.error.set('Authentication timeout - please try again');
					this.isLoading.set(false);
					// Stop OAuth server if we were using localhost approach
					if (!this.config.useCustomProtocol) {
						await invoke('stop_oauth_server');
					}
					return;
				}

				// Continue polling
				setTimeout(poll, 1000);
			} catch (error) {
				jsLog.error('=== POLLING ERROR ===');
				jsLog.error(`Error details: ${error}`);
				jsLog.error(
					`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
				jsLog.error(
					`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
				);
				this.error.set(
					`Authentication polling failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
				this.isLoading.set(false);
				// Stop OAuth server if we were using localhost approach
				if (!this.config.useCustomProtocol) {
					await invoke('stop_oauth_server');
				}
			}
		};

		poll();
	}

	private async handleAuthCallback(callbackData: {
		code?: string;
		state?: string;
		error?: string;
	}) {
		try {
			if (callbackData.error) {
				jsLog.error(`Error found in callback: ${callbackData.error}`);
				throw new Error(`Auth error: ${callbackData.error}`);
			}

			if (!callbackData.code || !callbackData.state) {
				jsLog.error('Missing required parameters');
				throw new Error('Missing authorization code or state');
			}

			// Verify state
			const storedState = sessionStorage.getItem('auth0_state');

			if (callbackData.state !== storedState) {
				jsLog.error('State mismatch - authentication failed');
				throw new Error('Invalid state parameter');
			}

			// Get stored code verifier
			const codeVerifier = sessionStorage.getItem('auth0_code_verifier');
			if (!codeVerifier) {
				jsLog.error('Missing code verifier');
				throw new Error('Missing code verifier');
			}

			// Exchange code for tokens
			await this.exchangeCodeForTokens(callbackData.code, codeVerifier);

			// Clean up
			sessionStorage.removeItem('auth0_state');
			sessionStorage.removeItem('auth0_code_verifier');

			// Stop OAuth server if we were using localhost approach
			if (!this.config.useCustomProtocol) {
				await invoke('stop_oauth_server');
			}
		} catch (error) {
			jsLog.error('=== CALLBACK HANDLING ERROR ===');
			jsLog.error(`Callback handling error: ${error}`);
			jsLog.error(
				`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
			jsLog.error(
				`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
			);
			this.error.set(
				error instanceof Error
					? error.message
					: 'Authentication callback failed',
			);
			// Stop OAuth server if we were using localhost approach
			if (!this.config.useCustomProtocol) {
				await invoke('stop_oauth_server');
			}
		} finally {
			this.isLoading.set(false);
		}
	}

	private async requestTokens(grant: TokenGrant) {
		// The generic HTTP plugin adds Origin, which makes Auth0 treat this native
		// app as a browser and withhold non-rotating refresh tokens.
		return this.boundedVoiceRequest(invoke<{
			status: number; payload: TokenResponse & { error?: string; error_description?: string };
		}>('auth0_token_request', { grant }));
	}

	private async exchangeCodeForTokens(code: string, codeVerifier: string) {
		try {
			const { status, payload: tokens } = await this.requestTokens({
				grant_type: 'authorization_code',
				code,
				code_verifier: codeVerifier,
			});
			if (status < 200 || status >= 300) throw new Error('Sign-in token exchange failed. Please try again.');
			if (!tokens.access_token || !Number.isFinite(tokens.expires_in)) throw new Error('Invalid sign-in response');

			// Store tokens with expiration time

			const expirationTime = Date.now() + tokens.expires_in * 1000;
			const tokenData = {
				...tokens,
				expiration_time: expirationTime,
			};
			await this.storeTokens(tokenData);
			await this.applyTokenState(tokenData);
		} catch (error) {
			jsLog.error('=== TOKEN EXCHANGE ERROR ===');
			jsLog.error(`Token exchange error: ${error}`);
			jsLog.error(
				`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
			jsLog.error(
				`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
			);
			throw error;
		}
	}

	public async logout() {
		if (this.localMode) {
			this.error.set(
				'Close the local test app and stop its launcher to end this session.',
			);
			return;
		}
		try {
			this.isLoading.set(true);

			// Clear local state
			this.isAuthenticated.set(false);
			this.user.set(null);
			this.accessToken.set(null);
			this.error.set(null);

			// Clear stored tokens
			await this.clearStoredTokens();

			// For desktop apps, local logout is usually sufficient
			// If you need to clear Auth0 session across all apps, uncomment below:
			/*
			const logoutUrl = `https://${this.config.domain}/v2/logout?client_id=${this.config.clientId}`;

			
			try {
				await open(logoutUrl);

			} catch (browserError) {
				jsLog.error(`Failed to open browser for logout: ${browserError}`);
				// Don't throw here - local logout still succeeded
			}
			*/
		} catch (error) {
			jsLog.error('=== LOGOUT ERROR ===');
			jsLog.error(`Logout error: ${error}`);
			this.error.set(error instanceof Error ? error.message : 'Logout failed');
		} finally {
			this.isLoading.set(false);
		}
	}

	public async getAccessToken(): Promise<string | null> {
		await this.initialization;
		if (this.signInRequired) return null;
		if (this.localMode) return null; // Public account APIs never receive the local credential.
		if (this.cachedTokens?.access_token) {
			const expirationTime = this.cachedTokens.expiration_time as
				| number
				| undefined;
			if (!expirationTime || Date.now() >= expirationTime - 60_000) {
				const refreshed = await this.refreshToken();
				return refreshed;
			}
			return this.cachedTokens.access_token;
		}

		let token: string | null = null;
		const unsubscribe = this.accessToken.subscribe((value) => {
			token = value;
		});
		unsubscribe();

		if (token) {
			return token;
		}

		await this.loadStoredTokens();

		const unsubscribeAfterLoad = this.accessToken.subscribe((value) => {
			token = value;
		});
		unsubscribeAfterLoad();

		return token;
	}

	public async getAuthHeader(): Promise<string | null> {
		const token = await this.getAccessToken();
		return token ? `Bearer ${token}` : null;
	}

	private refreshInFlight: Promise<string | null> | undefined;
	public async refreshToken(): Promise<string | null> {
		if (this.signInRequired) return null;
		if (!this.refreshInFlight)
			this.refreshInFlight = this.performRefresh().finally(() => {
				this.refreshInFlight = undefined;
			});
		return this.refreshInFlight;
	}
	private async performRefresh(): Promise<string | null> {
		try {
			// Get stored tokens to check for refresh token
			const stored = await invoke<string | null>('get_stored_tokens');
			if (!stored) {
				jsLog.error('No stored tokens found for refresh');
				this.requireSignIn();
				return null;
			}

			const tokens = JSON.parse(stored);
			this.cachedTokens = tokens;
			if (!tokens.refresh_token) {
				this.requireSignIn();
				await this.clearStoredTokens();
				this.error.set('Your session cannot renew automatically because no refresh token was issued. Please sign in before recording. If this repeats, check Auth0 offline access and the Refresh Token grant.');
				return null;
			}

			const { status, payload } = await this.requestTokens({
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
			});
			if (status < 200 || status >= 300) {
				const errorData = payload;

				// If refresh token is invalid, clear stored tokens and require re-login
				if (
					status === 403 ||
					status === 401 ||
					errorData.error === 'invalid_grant'
				) {
					await this.clearStoredTokens();
					this.isAuthenticated.set(false);
					this.user.set(null);
					this.accessToken.set(null);
					this.requireSignIn();
				} else {
					this.error.set('Could not refresh your session. Check your connection and retry before recording.');
				}

				return null;
			}

			const newTokens = payload;
			if (!newTokens.access_token || !Number.isFinite(newTokens.expires_in))
				throw new Error('Invalid refresh response');

			// Store new tokens with expiration time
			const expirationTime = Date.now() + newTokens.expires_in * 1000;
			const tokenData = {
				...newTokens,
				expiration_time: expirationTime,
				refresh_token: newTokens.refresh_token || tokens.refresh_token,
				id_token: newTokens.id_token || tokens.id_token,
			};

			await this.storeTokens(tokenData);
			await this.applyTokenState(tokenData);

			return this.cachedTokens?.access_token ?? null;
		} catch (error) {
			jsLog.error('Token refresh failed');
			this.error.set('Could not refresh your session. Check your connection and retry before recording.');
			return null;
		}
	}
}

// Create singleton instance
export const auth0Service = new Auth0Service();

// Export stores for reactive components
export const {
	isLoading: isAuthLoading,
	isAuthenticated,
	user: authUser,
	error: authError,
	accessToken,
} = auth0Service;
