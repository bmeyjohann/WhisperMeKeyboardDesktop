import { Err, tryAsync } from 'wellcrafted/result';
import { extractErrorMessage } from 'wellcrafted/error';
import { fetch } from '@tauri-apps/plugin-http';
import type { HttpService, ConnectionError, ParseError } from '.';

export function createHttpServiceDesktop(): HttpService {
	return {
		async post({ body, url, schema, headers }) {
			const { data: response, error: responseError } = await tryAsync({
				try: () =>
					fetch(url, {
						method: 'POST',
						body,
						headers: headers,
					}),
				mapError: (error): ConnectionError => ({
					name: 'ConnectionError',
					message: 'Failed to establish connection',
					context: { url, body, headers },
					cause: error,
				}),
			});
			if (responseError) return Err(responseError);

			if (!response.ok) {
				return Err({
					name: 'ResponseError',
					status: response.status,
					message: extractErrorMessage(await response.json()),
					context: { url, body, headers },
					cause: responseError,
				});
			}

			const parseResult = await tryAsync({
				try: async () => {
					const json = await response.json();
					return schema.parse(json);
				},
				mapError: (error): ParseError => ({
					name: 'ParseError',
					message: 'Failed to parse response',
					context: { url, body, headers },
					cause: error,
				}),
			});
			return parseResult;
		},
	};
}
