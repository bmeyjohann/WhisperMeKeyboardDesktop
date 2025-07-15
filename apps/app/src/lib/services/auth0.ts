import { writable, type Writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import CryptoJS from 'crypto-js';

// JavaScript logging utility that sends logs to Rust terminal
const jsLog = {
	info: (message: string) => invoke('js_log', { level: 'info', message }),
	error: (message: string) => invoke('js_log', { level: 'error', message }),
	debug: (message: string) => invoke('js_log', { level: 'debug', message })
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
	[key: string]: any;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	token_type: string;
	expires_in: number;
}

class Auth0Service {
	private config: Auth0Config;
	private codeVerifier: string | null = null;
	private callbackPort = 3000;

	// Svelte stores for reactive state
	public isLoading: Writable<boolean> = writable(false);
	public isAuthenticated: Writable<boolean> = writable(false);
	public user: Writable<Auth0User | null> = writable(null);
	public error: Writable<string | null> = writable(null);
	public accessToken: Writable<string | null> = writable(null);

	constructor() {
		this.config = {
			domain: 'dev-v6bfenyhz8m15z6j.eu.auth0.com',
			clientId: 'Nobjj5cwIKiVfUP2iSfIVVRuouNUqlno',
			audience: '', // Remove audience if no backend API exists yet
			scope: 'openid profile email offline_access',
			useCustomProtocol: true // Back to custom protocol for debugging
		};

		this.initialize();
	}

	private async initialize() {
		// Check if we have stored tokens
		await this.loadStoredTokens();
	}

	private async loadStoredTokens() {
		try {
			const stored = await invoke<string | null>('get_stored_tokens');
			if (stored) {
				const tokens = JSON.parse(stored);
				if (tokens.access_token) {
					this.accessToken.set(tokens.access_token);
					await this.getUserInfo(tokens.access_token);
					this.isAuthenticated.set(true);
				}
			}
		} catch (error) {
			console.log('No stored tokens found or invalid tokens');
		}
	}

	private async storeTokens(tokens: TokenResponse) {
		try {
			await invoke('store_tokens', { tokens: JSON.stringify(tokens) });
		} catch (error) {
			console.error('Failed to store tokens:', error);
		}
	}

	private async clearStoredTokens() {
		try {
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
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let text = '';
		for (let i = 0; i < length; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	public async login() {
		try {
			jsLog.info('=== LOGIN STARTED ===');
			jsLog.info(`useCustomProtocol: ${this.config.useCustomProtocol}`);
			this.isLoading.set(true);
			this.error.set(null);

			// Generate PKCE parameters
			this.codeVerifier = this.generateCodeVerifier();
			const codeChallenge = this.generateCodeChallenge(this.codeVerifier);
			const state = this.generateRandomString(32);

			// Store state and code verifier for later verification
			sessionStorage.setItem('auth0_state', state);
			sessionStorage.setItem('auth0_code_verifier', this.codeVerifier);

			// Determine redirect URI based on configuration
			const redirectUri = this.config.useCustomProtocol 
				? 'whisperme://auth/callback'
				: `http://localhost:${this.callbackPort}/callback`;

			// Build authorization URL - use localhost for Firefox compatibility
			const browserRedirectUri = `http://localhost:${this.callbackPort}/callback`;
			
			const params = new URLSearchParams({
				response_type: 'code',
				client_id: this.config.clientId,
				redirect_uri: browserRedirectUri, // Always use localhost for browser compatibility
				scope: this.config.scope,
				state: state,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256'
			});

			// Remove the double encoding attempt
			// URLSearchParams already handles encoding correctly

			// Only add audience if it's configured
			if (this.config.audience) {
				params.set('audience', this.config.audience);
			}

			const authUrl = `https://${this.config.domain}/authorize?${params.toString()}`;

			console.log('=== URL CONSTRUCTION ===');
			console.log('Domain:', this.config.domain);
			console.log('Params object:', Object.fromEntries(params));
			console.log('Params string:', params.toString());
			console.log('Auth URL being opened:', authUrl);
			console.log('Redirect URI:', redirectUri);
			console.log('Auth URL length:', authUrl.length);
			
			// Remove the Firefox workaround attempt

			// Always start local server for browser compatibility
			jsLog.info('=== ABOUT TO START CALLBACK SERVER ===');
			await this.startCallbackServer();
			jsLog.info('=== CALLBACK SERVER STARTED ===');
			
			// Start polling for callback data from local server
			jsLog.info('=== ABOUT TO START POLLING ===');
			this.pollForCallback();
			jsLog.info('=== POLLING STARTED ===');

			// Open browser for authentication
			console.log('Opening browser...');
			
			// Show URL for debugging
			console.log('DEBUG: About to open URL:', authUrl);
			
			try {
				await open(authUrl);
				console.log('Browser opened successfully');
			} catch (openError) {
				console.error('Error opening browser:', openError);
				
				// Firefox fallback: try opening with Windows command
				if (process.platform === 'win32') {
					try {
						const { Command } = await import('@tauri-apps/plugin-shell');
						await Command.create('cmd', ['/c', 'start', '', authUrl]).execute();
						console.log('Opened with Windows command as fallback');
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
			console.log('Setting up deep link listener for custom protocol authentication');
			
			// Listen for deep link events from the plugin
			const { listen } = await import('@tauri-apps/api/event');
			
			await listen('deep-link', (event) => {
				console.log('Deep link event received:', event.payload);
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
			console.log('Handling deep link URL:', url);
			
			const urlObj = new URL(url);
			if (urlObj.protocol === 'whisperme:' && urlObj.pathname === '/auth/callback') {
				const params = new URLSearchParams(urlObj.search);
				const callbackData = {
					code: params.get('code') || undefined,
					state: params.get('state') || undefined,
					error: params.get('error') || undefined
				};
				
				console.log('Direct deep link callback data:', callbackData);
				await this.handleAuthCallback(callbackData);
			}
		} catch (error) {
			console.error('Failed to handle deep link URL:', error);
		}
	}

	private async startCallbackServer() {
		try {
			jsLog.info('=== STARTING CALLBACK SERVER ===');
			// Start HTTP server on Rust side to handle OAuth callback
			await invoke('start_oauth_server', { port: this.callbackPort });
			jsLog.info('OAuth server started successfully');
			
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
				jsLog.info(`=== POLLING ATTEMPT ${attempts} ===`);
				jsLog.info('About to call get_oauth_callback...');
				let callbackDataString: string | null = null;
				try {
					callbackDataString = await invoke<string | null>('get_oauth_callback');
					jsLog.info(`get_oauth_callback returned: ${callbackDataString}`);
					jsLog.info(`Callback data type: ${typeof callbackDataString}`);
					jsLog.info(`Callback data is truthy: ${!!callbackDataString}`);
					
					if (callbackDataString) {
						jsLog.info(`OAuth callback data received: ${callbackDataString}`);
						jsLog.info(`Raw callback data type: ${typeof callbackDataString}`);
						jsLog.info(`Raw callback data length: ${callbackDataString.length}`);
						
						try {
							const callbackData = JSON.parse(callbackDataString);
							jsLog.info(`Parsed callback data: ${JSON.stringify(callbackData)}`);
							jsLog.info(`Parsed callback data type: ${typeof callbackData}`);
							jsLog.info('About to call handleAuthCallback...');
							await this.handleAuthCallback(callbackData);
							jsLog.info('handleAuthCallback completed successfully');
						} catch (parseError) {
							jsLog.error('=== JSON PARSE ERROR ===');
							jsLog.error(`Parse error: ${parseError}`);
							jsLog.error(`Raw data that failed to parse: ${callbackDataString}`);
							this.error.set(`Failed to parse callback data: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
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
				jsLog.error(`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
				jsLog.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
				this.error.set(`Authentication polling failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
				this.isLoading.set(false);
				// Stop OAuth server if we were using localhost approach
				if (!this.config.useCustomProtocol) {
					await invoke('stop_oauth_server');
				}
			}
		};

		jsLog.info('=== STARTING OAUTH CALLBACK POLLING ===');
		jsLog.info(`Max attempts: ${maxAttempts}`);
		jsLog.info('Polling function defined, about to start...');
		poll();
	}

	private async handleAuthCallback(callbackData: { code?: string; state?: string; error?: string }) {
		try {
			jsLog.info('=== STARTING CALLBACK HANDLER ===');
			jsLog.info(`Callback data received: ${JSON.stringify(callbackData)}`);
			jsLog.info(`Callback data type: ${typeof callbackData}`);
			jsLog.info(`Callback data keys: ${Object.keys(callbackData)}`);
			
			if (callbackData.error) {
				jsLog.error(`Error found in callback: ${callbackData.error}`);
				throw new Error(`Auth error: ${callbackData.error}`);
			}

			jsLog.info('Checking for code and state...');
			jsLog.info(`Code: ${callbackData.code}, Type: ${typeof callbackData.code}`);
			jsLog.info(`State: ${callbackData.state}, Type: ${typeof callbackData.state}`);

			if (!callbackData.code || !callbackData.state) {
				jsLog.error('Missing required parameters');
				throw new Error('Missing authorization code or state');
			}

			// Verify state
			const storedState = sessionStorage.getItem('auth0_state');
			jsLog.info('=== STATE VERIFICATION ===');
			jsLog.info(`Received state: ${callbackData.state}`);
			jsLog.info(`Stored state: ${storedState}`);
			jsLog.info(`States match: ${callbackData.state === storedState}`);
			
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

			jsLog.info('=== STARTING TOKEN EXCHANGE ===');
			jsLog.info(`Code verifier found: ${!!codeVerifier}`);
			jsLog.info(`Authorization code: ${callbackData.code?.substring(0, 10)}...`);
			
			// Exchange code for tokens
			await this.exchangeCodeForTokens(callbackData.code, codeVerifier);

			jsLog.info('=== TOKEN EXCHANGE COMPLETED ===');
			
			// Clean up
			sessionStorage.removeItem('auth0_state');
			sessionStorage.removeItem('auth0_code_verifier');
			
			// Stop OAuth server if we were using localhost approach
			if (!this.config.useCustomProtocol) {
				await invoke('stop_oauth_server');
			}

			jsLog.info('=== OAUTH CALLBACK HANDLED SUCCESSFULLY ===');
		} catch (error) {
			jsLog.error('=== CALLBACK HANDLING ERROR ===');
			jsLog.error(`Callback handling error: ${error}`);
			jsLog.error(`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
			jsLog.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
			this.error.set(error instanceof Error ? error.message : 'Authentication callback failed');
			// Stop OAuth server if we were using localhost approach
			if (!this.config.useCustomProtocol) {
				await invoke('stop_oauth_server');
			}
		} finally {
			this.isLoading.set(false);
		}
	}

	private async exchangeCodeForTokens(code: string, codeVerifier: string) {
		try {
			const tokenUrl = `https://${this.config.domain}/oauth/token`;
			
			// Always use localhost redirect URI for token exchange since that's what actually receives the callback
			const redirectUri = `http://localhost:${this.callbackPort}/callback`;
			
			const body = new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: this.config.clientId,
				code,
				redirect_uri: redirectUri,
				code_verifier: codeVerifier
			});

			jsLog.info('=== TOKEN EXCHANGE REQUEST ===');
			jsLog.info(`URL: ${tokenUrl}`);
			jsLog.info(`Redirect URI: ${redirectUri}`);
			jsLog.info(`Client ID: ${this.config.clientId}`);
			jsLog.info(`Code length: ${code.length}`);
			jsLog.info(`Body params: ${body.toString()}`);

			jsLog.info('Making token exchange request...');
			const response = await tauriFetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: body.toString()
			});

			jsLog.info(`Token exchange response status: ${response.status}`);
			jsLog.info(`Token exchange response ok: ${response.ok}`);

			if (!response.ok) {
				const errorData = await response.json();
				jsLog.error(`Token exchange failed: ${JSON.stringify(errorData)}`);
				throw new Error(`Token exchange failed: ${errorData.error_description || errorData.error}`);
			}

			const tokens: TokenResponse = await response.json();
			jsLog.info('=== TOKEN EXCHANGE SUCCESSFUL ===');
			jsLog.info(`Received access token: ${!!tokens.access_token}`);
			jsLog.info(`Received refresh token: ${!!tokens.refresh_token}`);
			jsLog.info(`Token type: ${tokens.token_type}`);
			
			// Store tokens
			jsLog.info('Storing tokens...');
			await this.storeTokens(tokens);
			this.accessToken.set(tokens.access_token);
			jsLog.info('Access token stored in state');

			// Get user info
			jsLog.info('Fetching user info...');
			await this.getUserInfo(tokens.access_token);
			jsLog.info('User info retrieved');
			
			this.isAuthenticated.set(true);
			jsLog.info('Authentication state set to true');

			jsLog.info('=== USER AUTHENTICATED SUCCESSFULLY ===');
		} catch (error) {
			jsLog.error('=== TOKEN EXCHANGE ERROR ===');
			jsLog.error(`Token exchange error: ${error}`);
			jsLog.error(`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
			jsLog.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
			throw error;
		}
	}

	private async getUserInfo(accessToken: string) {
		try {
			const userInfoUrl = `https://${this.config.domain}/userinfo`;
			
			jsLog.info('=== FETCHING USER INFO ===');
			jsLog.info(`URL: ${userInfoUrl}`);
			jsLog.info(`Access token available: ${!!accessToken}`);
			
			const response = await tauriFetch(userInfoUrl, {
				headers: {
					'Authorization': `Bearer ${accessToken}`
				}
			});

			jsLog.info(`User info response status: ${response.status}`);
			jsLog.info(`User info response ok: ${response.ok}`);

			if (!response.ok) {
				jsLog.error(`User info request failed: ${response.status} ${response.statusText}`);
				throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
			}

			const userInfo: Auth0User = await response.json();
			jsLog.info('=== USER INFO RECEIVED ===');
			jsLog.info(`User subject: ${userInfo.sub}`);
			jsLog.info(`User email: ${userInfo.email}`);
			this.user.set(userInfo);
			jsLog.info('User info stored in state');

		} catch (error) {
			jsLog.error('=== USER INFO ERROR ===');
			jsLog.error(`Failed to get user info: ${error}`);
			jsLog.error(`Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
			jsLog.error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
			// Don't throw here, we still have valid tokens
			// Set a minimal user object so authentication can complete
			this.user.set({ sub: 'unknown' });
			jsLog.info('Set fallback user info');
		}
	}

	public async logout() {
		try {
			this.isLoading.set(true);
			jsLog.info('=== LOGOUT STARTED ===');
			
			// Clear local state
			this.isAuthenticated.set(false);
			this.user.set(null);
			this.accessToken.set(null);
			this.error.set(null);

			// Clear stored tokens
			await this.clearStoredTokens();
			jsLog.info('Local state and tokens cleared');

			// For desktop apps, local logout is usually sufficient
			// If you need to clear Auth0 session across all apps, uncomment below:
			/*
			const logoutUrl = `https://${this.config.domain}/v2/logout?client_id=${this.config.clientId}`;
			jsLog.info(`Generated logout URL: ${logoutUrl}`);
			
			try {
				await open(logoutUrl);
				jsLog.info('Browser opened successfully for logout');
			} catch (browserError) {
				jsLog.error(`Failed to open browser for logout: ${browserError}`);
				// Don't throw here - local logout still succeeded
			}
			*/

			jsLog.info('=== LOGOUT COMPLETED ===');

		} catch (error) {
			jsLog.error('=== LOGOUT ERROR ===');
			jsLog.error(`Logout error: ${error}`);
			this.error.set(error instanceof Error ? error.message : 'Logout failed');
		} finally {
			this.isLoading.set(false);
		}
	}

	public async getAccessToken(): Promise<string | null> {
		// TODO: Add token refresh logic here if needed
		let token: string | null = null;
		this.accessToken.subscribe(value => token = value)();
		return token;
	}

	public async getAuthHeader(): Promise<string | null> {
		const token = await this.getAccessToken();
		return token ? `Bearer ${token}` : null;
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
	accessToken
} = auth0Service; 