import { auth0Service } from './auth0';

interface RequestOptions extends RequestInit {
	requireAuth?: boolean;
	retryOnAuth?: boolean;
}

class HttpClient {
	private baseURL: string;

	constructor(baseURL: string = '') {
		this.baseURL = baseURL;
	}

	private async getHeaders(requireAuth: boolean = false): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (requireAuth) {
			const authHeader = await auth0Service.getAuthHeader();
			if (authHeader) {
				headers['Authorization'] = authHeader;
			} else {
				throw new Error('Authentication required but no valid token available');
			}
		}

		return headers;
	}

	private async makeRequest<T>(
		endpoint: string,
		options: RequestOptions = {}
	): Promise<T> {
		const {
			requireAuth = false,
			retryOnAuth = true,
			headers: customHeaders = {},
			...fetchOptions
		} = options;

		try {
			const defaultHeaders = await this.getHeaders(requireAuth);
			const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;

			const response = await fetch(url, {
				...fetchOptions,
				headers: {
					...defaultHeaders,
					...customHeaders,
				},
			});

			// Handle 401 responses by attempting token refresh
			if (response.status === 401 && retryOnAuth && requireAuth) {
				const refreshedToken = await auth0Service.refreshToken();
				if (refreshedToken) {
					// Retry the request with the new token
					const retryHeaders = await this.getHeaders(requireAuth);
					const retryResponse = await fetch(url, {
						...fetchOptions,
						headers: {
							...retryHeaders,
							...customHeaders,
						},
					});

					if (!retryResponse.ok) {
						throw new Error(`HTTP error! status: ${retryResponse.status}`);
					}

					return await retryResponse.json();
				} else {
					// Token refresh failed, redirect to login
					throw new Error('Authentication expired. Please log in again.');
				}
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
			}

			// Handle empty responses
			const contentType = response.headers.get('content-type');
			if (contentType && contentType.includes('application/json')) {
				return await response.json();
			} else {
				return (await response.text()) as unknown as T;
			}
		} catch (error) {
			console.error('HTTP request failed:', error);
			throw error;
		}
	}

	// GET request
	async get<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
		return this.makeRequest<T>(endpoint, {
			...options,
			method: 'GET',
		});
	}

	// POST request
	async post<T>(
		endpoint: string,
		data?: any,
		options: RequestOptions = {}
	): Promise<T> {
		return this.makeRequest<T>(endpoint, {
			...options,
			method: 'POST',
			body: data ? JSON.stringify(data) : undefined,
		});
	}

	// PUT request
	async put<T>(
		endpoint: string,
		data?: any,
		options: RequestOptions = {}
	): Promise<T> {
		return this.makeRequest<T>(endpoint, {
			...options,
			method: 'PUT',
			body: data ? JSON.stringify(data) : undefined,
		});
	}

	// PATCH request
	async patch<T>(
		endpoint: string,
		data?: any,
		options: RequestOptions = {}
	): Promise<T> {
		return this.makeRequest<T>(endpoint, {
			...options,
			method: 'PATCH',
			body: data ? JSON.stringify(data) : undefined,
		});
	}

	// DELETE request
	async delete<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
		return this.makeRequest<T>(endpoint, {
			...options,
			method: 'DELETE',
		});
	}

	// File upload
	async uploadFile<T>(
		endpoint: string,
		file: File,
		additionalFields: Record<string, string> = {},
		options: RequestOptions = {}
	): Promise<T> {
		const { requireAuth = false, retryOnAuth = true, ...fetchOptions } = options;

		const formData = new FormData();
		formData.append('file', file);

		Object.entries(additionalFields).forEach(([key, value]) => {
			formData.append(key, value);
		});

		try {
			const headers: Record<string, string> = {};
			
			if (requireAuth) {
				const authHeader = await auth0Service.getAuthHeader();
				if (authHeader) {
					headers['Authorization'] = authHeader;
				} else {
					throw new Error('Authentication required but no valid token available');
				}
			}

			const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;

			const response = await fetch(url, {
				...fetchOptions,
				method: 'POST',
				headers,
				body: formData,
			});

			// Handle 401 responses
			if (response.status === 401 && retryOnAuth && requireAuth) {
				const refreshedToken = await auth0Service.refreshToken();
				if (refreshedToken) {
					const retryHeaders: Record<string, string> = {};
					const authHeader = await auth0Service.getAuthHeader();
					if (authHeader) {
						retryHeaders['Authorization'] = authHeader;
					}

					const retryResponse = await fetch(url, {
						...fetchOptions,
						method: 'POST',
						headers: retryHeaders,
						body: formData,
					});

					if (!retryResponse.ok) {
						throw new Error(`HTTP error! status: ${retryResponse.status}`);
					}

					return await retryResponse.json();
				}
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
			}

			return await response.json();
		} catch (error) {
			console.error('File upload failed:', error);
			throw error;
		}
	}
}

// Create instances for different base URLs
export const apiClient = new HttpClient('https://whisperme-app.com/api'); // Your API base URL
export const httpClient = new HttpClient(); // For external APIs

// Export the class for custom instances
export { HttpClient }; 