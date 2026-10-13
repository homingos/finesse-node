import type { Core, RequestOptions } from "../core.js";
import type { AccessToken } from "../types.js";

export interface CreateTokenParams {
  /** How long the token stays valid if unused, 10-3600 seconds. Default 300. */
  ttl_seconds?: number;
  /** Limit the token to these voices (yours or public platform voices). */
  voice_ids?: string[];
}

/** Short-lived tokens, so a browser or device can synthesize without your API key. */
export class Tokens {
  constructor(private readonly core: Core) {}

  /** Mint a single-use token. Call this on your server with an API key that has the `tts`
   * scope, and send only the token to the client:
   *
   * ```ts
   * const { token } = await client.tokens.create({ ttl_seconds: 60, voice_ids: [voiceId] });
   * ```
   */
  async create(params: CreateTokenParams = {}, options: RequestOptions = {}): Promise<AccessToken> {
    const json: Record<string, unknown> = {};
    if (params.ttl_seconds !== undefined) json.ttl_seconds = params.ttl_seconds;
    if (params.voice_ids !== undefined) json.voice_ids = params.voice_ids;
    return this.core.json<AccessToken>("POST", "/tokens", { ...options, json });
  }
}
