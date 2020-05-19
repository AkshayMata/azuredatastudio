/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, } from 'vs/base/common/lifecycle';
import { IUserData, IUserDataSyncStoreService, UserDataSyncErrorCode, IUserDataSyncStore, getUserDataSyncStore, SyncResource, UserDataSyncStoreError, IUserDataSyncLogService, IUserDataManifest, IResourceRefHandle } from 'vs/platform/userDataSync/common/userDataSync';
import { IRequestService, asText, isSuccess, asJson } from 'vs/platform/request/common/request';
import { joinPath, relativePath } from 'vs/base/common/resources';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IHeaders, IRequestOptions, IRequestContext } from 'vs/base/parts/request/common/request';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IAuthenticationTokenService } from 'vs/platform/authentication/common/authentication';
import { IProductService } from 'vs/platform/product/common/productService';
import { getServiceMachineId } from 'vs/platform/serviceMachineId/common/serviceMachineId';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService } from 'vs/platform/files/common/files';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { assign } from 'vs/base/common/objects';
import { generateUuid } from 'vs/base/common/uuid';
import { isWeb } from 'vs/base/common/platform';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

const USER_SESSION_ID_KEY = 'sync.user-session-id';
const MACHINE_SESSION_ID_KEY = 'sync.machine-session-id';
const REQUEST_SESSION_LIMIT = 100;
const REQUEST_SESSION_INTERVAL = 1000 * 60 * 5; /* 5 minutes */

export class UserDataSyncStoreService extends Disposable implements IUserDataSyncStoreService {

	_serviceBrand: any;

	readonly userDataSyncStore: IUserDataSyncStore | undefined;
	private readonly commonHeadersPromise: Promise<{ [key: string]: string; }>;
	private readonly session: RequestsSession;

	constructor(
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@IAuthenticationTokenService private readonly authTokenService: IAuthenticationTokenService,
		@IUserDataSyncLogService private readonly logService: IUserDataSyncLogService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super();
		this.userDataSyncStore = getUserDataSyncStore(productService, configurationService);
		this.commonHeadersPromise = getServiceMachineId(environmentService, fileService, storageService)
			.then(uuid => {
				const headers: IHeaders = {
					'X-Client-Name': `${productService.applicationName}${isWeb ? '-web' : ''}`,
					'X-Client-Version': productService.version,
					'X-Machine-Id': uuid
				};
				if (productService.commit) {
					headers['X-Client-Commit'] = productService.commit;
				}
				return headers;
			});

		/* A requests session that limits requests per sessions */
		this.session = new RequestsSession(REQUEST_SESSION_LIMIT, REQUEST_SESSION_INTERVAL, this.requestService, telemetryService);
	}

	async getAllRefs(resource: SyncResource): Promise<IResourceRefHandle[]> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const uri = joinPath(this.userDataSyncStore.url, 'resource', resource);
		const headers: IHeaders = {};

		const context = await this.request({ type: 'GET', url: uri.toString(), headers }, undefined, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown, undefined);
		}

		const result = await asJson<{ url: string, created: number }[]>(context) || [];
		return result.map(({ url, created }) => ({ ref: relativePath(uri, uri.with({ path: url }))!, created: created * 1000 /* Server returns in seconds */ }));
	}

	async resolveContent(resource: SyncResource, ref: string): Promise<string | null> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'resource', resource, ref).toString();
		const headers: IHeaders = {};
		headers['Cache-Control'] = 'no-cache';

		const context = await this.request({ type: 'GET', url, headers }, undefined, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown, undefined);
		}

		const content = await asText(context);
		return content;
	}

	async delete(resource: SyncResource): Promise<void> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'resource', resource).toString();
		const headers: IHeaders = {};

		const context = await this.request({ type: 'DELETE', url, headers }, undefined, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown, undefined);
		}
	}

	async read(resource: SyncResource, oldValue: IUserData | null): Promise<IUserData> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'resource', resource, 'latest').toString();
		const headers: IHeaders = {};
		// Disable caching as they are cached by synchronisers
		headers['Cache-Control'] = 'no-cache';
		if (oldValue) {
			headers['If-None-Match'] = oldValue.ref;
		}

		const context = await this.request({ type: 'GET', url, headers }, resource, CancellationToken.None);

		if (context.res.statusCode === 304) {
			// There is no new value. Hence return the old value.
			return oldValue!;
		}

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown, resource);
		}

		const ref = context.res.headers['etag'];
		if (!ref) {
			throw new UserDataSyncStoreError('Server did not return the ref', UserDataSyncErrorCode.NoRef, resource);
		}
		const content = await asText(context);
		return { ref, content };
	}

	async write(resource: SyncResource, data: string, ref: string | null): Promise<string> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'resource', resource).toString();
		const headers: IHeaders = { 'Content-Type': 'text/plain' };
		if (ref) {
			headers['If-Match'] = ref;
		}

		const context = await this.request({ type: 'POST', url, data, headers }, resource, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown, resource);
		}

		const newRef = context.res.headers['etag'];
		if (!newRef) {
			throw new UserDataSyncStoreError('Server did not return the ref', UserDataSyncErrorCode.NoRef, resource);
		}
		return newRef;
	}

	async manifest(): Promise<IUserDataManifest | null> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'manifest').toString();
		const headers: IHeaders = { 'Content-Type': 'application/json' };

		const context = await this.request({ type: 'GET', url, headers }, undefined, CancellationToken.None);
		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown);
		}

		const manifest = await asJson<IUserDataManifest>(context);
		const currentSessionId = this.storageService.get(USER_SESSION_ID_KEY, StorageScope.GLOBAL);

		if (currentSessionId && manifest && currentSessionId !== manifest.session) {
			// Server session is different from client session so clear cached session.
			this.clearSession();
		}

		if (manifest === null && currentSessionId) {
			// server session is cleared so clear cached session.
			this.clearSession();
		}

		if (manifest) {
			// update session
			this.storageService.store(USER_SESSION_ID_KEY, manifest.session, StorageScope.GLOBAL);
		}

		return manifest;
	}

	async clear(): Promise<void> {
		if (!this.userDataSyncStore) {
			throw new Error('No settings sync store url configured.');
		}

		const url = joinPath(this.userDataSyncStore.url, 'resource').toString();
		const headers: IHeaders = { 'Content-Type': 'text/plain' };

		const context = await this.request({ type: 'DELETE', url, headers }, undefined, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new UserDataSyncStoreError('Server returned ' + context.res.statusCode, UserDataSyncErrorCode.Unknown);
		}

		// clear cached session.
		this.clearSession();
	}

	private clearSession(): void {
		this.storageService.remove(USER_SESSION_ID_KEY, StorageScope.GLOBAL);
		this.storageService.remove(MACHINE_SESSION_ID_KEY, StorageScope.GLOBAL);
	}

	private async request(options: IRequestOptions, source: SyncResource | undefined, token: CancellationToken): Promise<IRequestContext> {
		const authToken = this.authTokenService.token;
		if (!authToken) {
			throw new UserDataSyncStoreError('No Auth Token Available', UserDataSyncErrorCode.Unauthorized, source);
		}

		const commonHeaders = await this.commonHeadersPromise;
		options.headers = assign(options.headers || {}, commonHeaders, {
			'X-Account-Type': authToken.authenticationProviderId,
			'authorization': `Bearer ${authToken.token}`,
		});

		// Add session headers
		this.addSessionHeaders(options.headers);

		this.logService.trace('Sending request to server', { url: options.url, type: options.type, headers: { ...options.headers, ...{ authorization: undefined } } });

		let context;
		try {
			context = await this.session.request(options, token);
			this.logService.trace('Request finished', { url: options.url, status: context.res.statusCode });
		} catch (e) {
			if (!(e instanceof UserDataSyncStoreError)) {
				e = new UserDataSyncStoreError(`Connection refused for the request '${options.url?.toString()}'.`, UserDataSyncErrorCode.ConnectionRefused, source);
			}
			throw e;
		}

		if (context.res.statusCode === 401) {
			this.authTokenService.sendTokenFailed();
			throw new UserDataSyncStoreError(`Request '${options.url?.toString()}' failed because of Unauthorized (401).`, UserDataSyncErrorCode.Unauthorized, source);
		}

		if (context.res.statusCode === 403) {
			throw new UserDataSyncStoreError(`Request '${options.url?.toString()}' is Forbidden (403).`, UserDataSyncErrorCode.Forbidden, source);
		}

		if (context.res.statusCode === 412) {
			throw new UserDataSyncStoreError(`${options.type} request '${options.url?.toString()}' failed because of Precondition Failed (412). There is new data exists for this resource. Make the request again with latest data.`, UserDataSyncErrorCode.RemotePreconditionFailed, source);
		}

		if (context.res.statusCode === 413) {
			throw new UserDataSyncStoreError(`${options.type} request '${options.url?.toString()}' failed because of too large payload (413).`, UserDataSyncErrorCode.TooLarge, source);
		}

		if (context.res.statusCode === 429) {
			throw new UserDataSyncStoreError(`${options.type} request '${options.url?.toString()}' failed because of too many requests (429).`, UserDataSyncErrorCode.TooManyRequests, source);
		}

		return context;
	}

	private addSessionHeaders(headers: IHeaders): void {
		let machineSessionId = this.storageService.get(MACHINE_SESSION_ID_KEY, StorageScope.GLOBAL);
		if (machineSessionId === undefined) {
			machineSessionId = generateUuid();
			this.storageService.store(MACHINE_SESSION_ID_KEY, machineSessionId, StorageScope.GLOBAL);
		}
		headers['X-Machine-Session-Id'] = machineSessionId;

		const userSessionId = this.storageService.get(USER_SESSION_ID_KEY, StorageScope.GLOBAL);
		if (userSessionId !== undefined) {
			headers['X-User-Session-Id'] = userSessionId;
		}
	}

}

class RequestsSession {

	private count: number = 0;
	private startTime: Date | undefined = undefined;

	constructor(
		private readonly limit: number,
		private readonly interval: number, /* in ms */
		private readonly requestService: IRequestService,
		private readonly telemetryService: ITelemetryService
	) { }

	request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (this.isExpired()) {
			this.reset();
		}

		if (this.count >= this.limit) {
			this.telemetryService.publicLog2(`sync/error/${UserDataSyncErrorCode.LocalTooManyRequests}`);
			throw new UserDataSyncStoreError(`Too many requests. Allowed only ${this.limit} requests in ${this.interval / (1000 * 60)} minutes.`, UserDataSyncErrorCode.LocalTooManyRequests);
		}

		this.startTime = this.startTime || new Date();
		this.count++;

		return this.requestService.request(options, token);
	}

	private isExpired(): boolean {
		return this.startTime !== undefined && new Date().getTime() - this.startTime.getTime() > this.interval;
	}

	private reset(): void {
		this.count = 0;
		this.startTime = undefined;
	}

}
