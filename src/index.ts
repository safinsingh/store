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

type SkinTier = "Select" | "Deluxe" | "Premium" | "Ultra" | "Exclusive";
type SkinMeta = {
	displayName: string;
	price: number;
	tier: SkinTier;
	image: string;
};
type StorefrontResponse = {
	offers: {
		expiration: Date;
		items: Array<SkinMeta>;
	};
};

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
		BundleRemainingDurationInSeconds: string;
	};
	SkinsPanelLayout: {
		SingleItemOffers: [string, string, string, string];
		SingleItemOffersRemainingDurationInSeconds: number;
	};
};

class Storefront {
	authProvider: AuthProvider;

	constructor(authProvider: AuthProvider) {
		this.authProvider = authProvider;
	}

	async getOffers() {
		const bundle = await this.authProvider.getAuthBundle();
		const offers = await this._getOffersRaw(bundle);
		const skins = offers.SkinsPanelLayout.SingleItemOffers;

		const skinsjson = JSON.parse(fs.readFileSync("skins.json", "utf-8"));
		console.log(skins.map((uuid) => skinsjson[uuid].display_name));
	}

	private async _getOffersRaw(bundle: RiotAuthBundle) {
		const storefrontResponse = await axios.get<RiotStorefrontResponse>(
			RIOT_STOREFRONT_ENDPOINT(bundle.puuid),
			{
				headers: {
					"X-Riot-Entitlements-JWT": bundle.entitlementsToken,
					authorization: `Bearer ${bundle.riotToken}`,
				},
			}
		);
		const storefrontData = storefrontResponse.data;
		return storefrontData;
	}
}

(async () => {
	dotenv.config();
	const { __riot_username, __riot_password } = process.env;

	const auth = new PasswordAuthProvider(__riot_username!, __riot_password!);
	const store = new Storefront(auth);

	store.getOffers();
})();
