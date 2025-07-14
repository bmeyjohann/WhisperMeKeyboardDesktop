import { createAuth0Client, type Auth0Client, type User } from '@auth0/auth0-spa-js';
import { writable, type Writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

interface Auth0Config {
	domain: string;
	clientId: string;
	audience: string;
	redirectUri: string;
}

class Auth0Service {
	private client: Auth0Client | null = null;
	private config: Auth0Config;

	// Svelte stores for reactive state
	public isLoading: Writable<boolean> = writable(true);
	public isAuthenticated: Writable<boolean> = writable(false);
	public user: Writable<User | null> = writable(null);
	public error: Writable<string | null> = writable(null);
	public accessToken: Writable<string | null> = writable(null);

	constructor() {
		this.config = {
			domain: 'dev-v6bfenyhz8m15z6j.eu.auth0.com',
			clientId: 'Nobjj5cwIKiVfUP2iSfIVVRuouNUqlno',
			audience: 'https://whisperme-app.com/api',
			redirectUri: window.location.origin + '/callback'
		};

		this.initialize();
	}

	private async initialize() {
		try {
			this.isLoading.set(true);
			this.error.set(null);

			this.client = await createAuth0Client({
				domain: this.config.domain,
				clientId: this.config.clientId,
				authorizationParams: {
					audience: this.config.audience,
					redirect_uri: this.config.redirectUri,
					scope: 'openid profile email offline_access'
				},
				useRefreshTokens: true,
				cacheLocation: 'localstorage'
			});

			// Check if we're returning from login
			if (window.location.search.includes('code=') && window.location.search.includes('state=')) {
				await this.handleRedirectCallback();
			}

			// Check if user is authenticated
			const isAuthenticated = await this.client.isAuthenticated();
			this.isAuthenticated.set(isAuthenticated);

			if (isAuthenticated) {
				const user = await this.client.getUser();
				const token = await this.client.getTokenSilently();
				this.user.set(user || null);
				this.accessToken.set(token);
			}
		} catch (error) {
			console.error('Auth0 initialization error:', error);
			this.error.set(error instanceof Error ? error.message : 'Authentication initialization failed');
		} finally {
			this.isLoading.set(false);
		}
	}

	private async handleRedirectCallback() {
		try {
			if (!this.client) throw new Error('Auth0 client not initialized');
			
			const result = await this.client.handleRedirectCallback();
			
			// Clean up the URL
			window.history.replaceState({}, document.title, window.location.pathname);
			
			return result;
		} catch (error) {
			console.error('Redirect callback error:', error);
			this.error.set(error instanceof Error ? error.message : 'Login callback failed');
			throw error;
		}
	}

	public async login() {
		try {
			if (!this.client) throw new Error('Auth0 client not initialized');
			
			this.error.set(null);
			await this.client.loginWithRedirect({
				authorizationParams: {
					audience: this.config.audience,
					scope: 'openid profile email offline_access'
				}
			});
		} catch (error) {
			console.error('Login error:', error);
			this.error.set(error instanceof Error ? error.message : 'Login failed');
			throw error;
		}
	}

	public async logout() {
		try {
			if (!this.client) throw new Error('Auth0 client not initialized');
			
			// Clear stores
			this.isAuthenticated.set(false);
			this.user.set(null);
			this.accessToken.set(null);
			this.error.set(null);

			await this.client.logout({
				logoutParams: {
					returnTo: window.location.origin
				}
			});
		} catch (error) {
			console.error('Logout error:', error);
			this.error.set(error instanceof Error ? error.message : 'Logout failed');
		}
	}

	public async getAccessToken(): Promise<string | null> {
		try {
			if (!this.client) return null;
			
			const token = await this.client.getTokenSilently();
			this.accessToken.set(token);
			return token;
		} catch (error) {
			console.error('Token retrieval error:', error);
			// If token retrieval fails, user might need to re-authenticate
			this.isAuthenticated.set(false);
			this.user.set(null);
			this.accessToken.set(null);
			return null;
		}
	}

	public async getAuthHeader(): Promise<string | null> {
		const token = await this.getAccessToken();
		return token ? `Bearer ${token}` : null;
	}

	public async refreshToken(): Promise<string | null> {
		try {
			if (!this.client) return null;
			
			const token = await this.client.getTokenSilently({
				cacheMode: 'off' // Force refresh
			});
			this.accessToken.set(token);
			return token;
		} catch (error) {
			console.error('Token refresh error:', error);
			return null;
		}
	}

	public async checkSession() {
		try {
			if (!this.client) return false;
			
			const isAuthenticated = await this.client.isAuthenticated();
			this.isAuthenticated.set(isAuthenticated);
			
			if (isAuthenticated) {
				const user = await this.client.getUser();
				const token = await this.getAccessToken();
				this.user.set(user || null);
				return true;
			}
			return false;
		} catch (error) {
			console.error('Session check error:', error);
			return false;
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
	accessToken
} = auth0Service; 