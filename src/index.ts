import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";
import https from "node:https";
import fs from "node:fs";

const RIOT_TLS_CIPHERS = [
	"TLS_CHACHA20_POLY1305_SHA256",
	"TLS_AES_128_GCM_SHA256",
	"TLS_AES_256_GCM_SHA384",
	"TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
];
const RIOT_AUTHORIZATION_ENDPOINT =
	"https://auth.riotgames.com/api/v1/authorization";
const RIOT_ENTITLEMENTS_ENDPOINT =
	"https://entitlements.auth.riotgames.com/api/token/v1";
const RIOT_STOREFRONT_ENDPOINT = (puuid: string) =>
	`https://pd.na.a.pvp.net/store/v2/storefront/${puuid}`;

type RiotAuthBundle = {
	riotToken: string;
	entitlementsToken: string;
	puuid: string;
	expiry: Date;
};
type RiotAuthTokens = Pick<RiotAuthBundle, "riotToken" | "entitlementsToken">;

// should implement reauth, etc
interface AuthProvider {
	getAuthBundle(): Promise<RiotAuthBundle>;
}

class AuthProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthProviderError";
		this.message = message;
	}
}

class PasswordAuthProvider implements AuthProvider {
	username: string;
	password: string;
	expiry: Date;
	bundle?: RiotAuthBundle;

	httpClient: AxiosInstance;

	constructor(username: string, password: string) {
		this.username = username;
		this.password = password;

		this.httpClient = axios.create({
			withCredentials: true,
			headers: {
				"User-Agent":
					"RiotClient/43.0.1.4195386.4190634 rso-auth (Windows; 10;;Professional, x64)",
			},
			httpsAgent: new https.Agent({
				ciphers: RIOT_TLS_CIPHERS.join(":"),
				honorCipherOrder: true,
				minVersion: "TLSv1.2",
			}),
		});
	}

	async getAuthBundle(): Promise<RiotAuthBundle> {
		if (!this.bundle || this.expiry < new Date()) {
			const riotToken = await this.getRiotToken();
			const entitlementsToken = await this.getentitlementsToken(riotToken);
			const puuid = await this.getPuuid(riotToken);

			const expiry = new Date();
			expiry.setMinutes(expiry.getMinutes() + 55); // 5 minute grace period

			this.bundle = { riotToken, entitlementsToken, puuid, expiry };
			return this.bundle;
		} else {
			return this.bundle;
		}
	}

	async getRiotToken() {
		const cookie = await this.httpClient
			.post(RIOT_AUTHORIZATION_ENDPOINT, {
				client_id: "play-valorant-web-prod",
				nonce: "1",
				redirect_uri: "https://playvalorant.com/opt_in",
				response_type: "token id_token",
			})
			.then((res) =>
				res.headers["set-cookie"]?.find((cookie) => cookie.startsWith("asid"))
			);
		if (!cookie)
			throw new AuthProviderError("Failed to retrieve authorization cookies");

		const authorizationResponse = await this.httpClient.put(
			RIOT_AUTHORIZATION_ENDPOINT,
			{
				type: "auth",
				username: this.username,
				password: this.password,
				remember: true,
				language: "en_US",
			},
			{ headers: { cookie } }
		);

		if (authorizationResponse.data.error) {
			throw new AuthProviderError(
				"Authentication failed, check your credentials"
			);
		}
		const authorizationUri = authorizationResponse.data.response.parameters.uri;
		const authorizationUriHash = new URL(authorizationUri).hash.substring(1); // trim leading #
		const authorizationToken = new URLSearchParams(authorizationUriHash).get(
			"access_token"
		);
		if (!authorizationToken) {
			throw new AuthProviderError(
				"Error retrieving authentication token from authorization URI"
			);
		}

		return authorizationToken;
	}

	async getentitlementsToken(authorizationToken: string) {
		const entitlementsResponse = await this.httpClient.post(
			RIOT_ENTITLEMENTS_ENDPOINT,
			{},
			{ headers: { Authorization: `Bearer ${authorizationToken}` } }
		);
		const entitlementsToken = entitlementsResponse.data.entitlements_token;
		if (!entitlementsToken)
			throw new AuthProviderError("Failed to retrieve entitlement token");
		return entitlementsToken;
	}

	async getPuuid(authorizationToken: string) {
		const userinfoResponse = await this.httpClient.get(
			"https://auth.riotgames.com/userinfo",
			{
				headers: { Authorization: `Bearer ${authorizationToken}` },
			}
		);
		const puuid = userinfoResponse.data.sub;

		if (!puuid) throw new AuthProviderError("Failed to retrieve puuid");
		return puuid;
	}
}

type RiotStorefrontResponse = {
	FeaturedBundle: {
		Bundle: {
			ID: string;
			DataAssetID: string;
			CurrencyID: string;
			Items: Array<{
				Item: {
					ItemTypeID: string;
					ItemID: string;
					Amount: number;
				};
				BasePrice: number;
				CurrencyID: string;
				DiscountPercent: number;
				DiscountPrice: number;
				IsPromoItem: boolean;
			}>;
			DurationRemainingInSeconds: number;
			WholesaleOnly: boolean;
		};
		BundleRemainingDurationInSeconds: number;
	};
	SkinsPanelLayout: {
		SingleItemOffers: [string, string, string, string];
		SingleItemOffersRemainingDurationInSeconds: number;
	};
};

type SkinTier = "Select" | "Deluxe" | "Premium" | "Ultra" | "Exclusive";
const SkinTierUUID: { [uuid: string]: { tier: SkinTier; image: string } } = {
	"12683d76-48d7-84a3-4e09-6985794f0445": {
		tier: "Select",
		image:
			"https://media.valorant-api.com/contenttiers/12683d76-48d7-84a3-4e09-6985794f0445/displayicon.png",
	},
	"0cebb8be-46d7-c12a-d306-e9907bfc5a25": {
		tier: "Deluxe",
		image:
			"https://media.valorant-api.com/contenttiers/0cebb8be-46d7-c12a-d306-e9907bfc5a25/displayicon.png",
	},
	"60bca009-4182-7998-dee7-b8a2558dc369": {
		tier: "Premium",
		image:
			"https://media.valorant-api.com/contenttiers/60bca009-4182-7998-dee7-b8a2558dc369/displayicon.png",
	},
	"411e4a55-4e59-7757-41f0-86a53f101bb5": {
		tier: "Ultra",
		image:
			"https://media.valorant-api.com/contenttiers/411e4a55-4e59-7757-41f0-86a53f101bb5/displayicon.png",
	},
	"e046854e-406c-37f4-6607-19a9ba8426fc": {
		tier: "Exclusive",
		image:
			"https://media.valorant-api.com/contenttiers/e046854e-406c-37f4-6607-19a9ba8426fc/displayicon.png",
	},
};
type SkinMeta = {
	displayName: string;
	price: number;
	tier: SkinTier;
	image: string;
};
type StorefrontResponse = {
	offers: {
		items: Array<SkinMeta>;
		expiry: Date;
	};
	bundle: {
		name: string;
		cover: string;
		expiry: Date;
	};
};

class Storefront {
	authProvider: AuthProvider;

	constructor(authProvider: AuthProvider) {
		this.authProvider = authProvider;
	}

	async getOffers(): StorefrontResponse {
		const bundle = await this.authProvider.getAuthBundle();
		const storefront = await this._getStorefrontRaw(bundle);

		const offersExpiry = new Date();
		const bundleExpiry = new Date();
		offersExpiry.setSeconds(
			offersExpiry.getSeconds() +
				storefront.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds
		);
		bundleExpiry.setSeconds(
			bundleExpiry.getSeconds() +
				storefront.FeaturedBundle.BundleRemainingDurationInSeconds
		);

		return {
			offers: {
				expiry: offersExpiry,
			},
			bundle: {
				name: storefront.FeaturedBundle.Bundle.DataAssetID,
				cover: storefront.FeaturedBundle.Bundle.CurrencyID,
				expiry: bundleExpiry,
			},
		};
	}

	private async _getStorefrontRaw(bundle: RiotAuthBundle) {
		const storefrontResponse = await axios.get<RiotStorefrontResponse>(
			RIOT_STOREFRONT_ENDPOINT(bundle.puuid),
			{
				headers: {
					"X-Riot-Entitlements-JWT": bundle.entitlementsToken,
					authorization: `Bearer ${bundle.riotToken}`,
				},
			}
		);
		return storefrontResponse.data;
	}
}

(async () => {
	dotenv.config();
	const { __riot_username, __riot_password } = process.env;

	const auth = new PasswordAuthProvider(__riot_username!, __riot_password!);
	const store = new Storefront(auth);

	store.getOffers();
})();
