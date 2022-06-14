import axios, { AxiosInstance } from "axios";
import url from "url";
import querystring from "querystring";
import dotenv from "dotenv";
import fs from "fs/promises";
import { Agent } from "https";

dotenv.config();

type Skin = {
	display_name: string;
	image: string;
};

const { __riot_username, __riot_password } = process.env;

function format_seconds(seconds: number) {
	const h = Math.floor(seconds / 3600)
		.toString()
		.padStart(2, "0");
	const m = Math.floor((seconds % 3600) / 60)
		.toString()
		.padStart(2, "0");
	const s = Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0");

	return `${h}:${m}:${s}`;
}

async function cache_skins_list() {
	const raw_skins_json = await axios.get(
		"https://valorant-api.com/v1/weapons/skins"
	);
	const skins_to_write: {
		[id: string]: Skin;
	} = {};
	for (const skin of raw_skins_json.data.data) {
		const skin_level = skin.levels[0];
		skins_to_write[skin_level.uuid] = {
			display_name: skin_level.displayName,
			image: skin_level.displayIcon,
		};
	}

	await fs.writeFile("skins.json", JSON.stringify(skins_to_write));
}

class User {
	client: AxiosInstance;
	riot_entitlement: string;
	riot_token: string;
	puuid: string;

	constructor() {
		const ciphers = [
			"TLS_CHACHA20_POLY1305_SHA256",
			"TLS_AES_128_GCM_SHA256",
			"TLS_AES_256_GCM_SHA384",
			"TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
		];
		const agent = new Agent({
			ciphers: ciphers.join(":"),
			honorCipherOrder: true,
			minVersion: "TLSv1.2",
		});

		this.client = axios.create({
			withCredentials: true,
			headers: {
				"User-Agent":
					"RiotClient/43.0.1.4195386.4190634 rso-auth (Windows; 10;;Professional, x64)",
			},
			httpsAgent: agent,
		});

		this.riot_entitlement = "";
		this.riot_token = "";
		this.puuid = "";
	}

	async login(username: string, password: string) {
		const res_a = await this.client.post(
			"https://auth.riotgames.com/api/v1/authorization",
			{
				client_id: "play-valorant-web-prod",
				nonce: "1",
				redirect_uri: "https://playvalorant.com/opt_in",
				response_type: "token id_token",
			}
		);

		const cookie = res_a.headers["set-cookie"]!.find((elem) =>
			/^asid/.test(elem)
		);

		const res = await this.client.put(
			"https://auth.riotgames.com/api/v1/authorization",
			{
				type: "auth",
				username: username,
				password: password,
				remember: true,
				language: "en_US",
			},
			{
				headers: {
					Cookie: cookie!,
				},
			}
		);

		const { uri } = res.data.response.parameters;
		const hash = url.parse(uri).hash!.substring(1); // remove leading #
		const { access_token } = querystring.parse(hash);

		const entitlement = await this.client.post(
			"https://entitlements.auth.riotgames.com/api/token/v1",
			{},
			{ headers: { Authorization: `Bearer ${access_token}` } }
		);

		const userid = await this.client.get(
			"https://auth.riotgames.com/userinfo",
			{
				headers: { Authorization: `Bearer ${access_token}` },
			}
		);

		this.riot_entitlement = entitlement.data.entitlements_token;
		this.riot_token = access_token as string;
		this.puuid = userid.data.sub;
	}

	async format_store_items(items: string[]) {
		const skins_raw = await fs.readFile("skins.json", "utf-8");
		const skins = JSON.parse(skins_raw);
		return items.map((id) => skins[id] as Skin);
	}

	async get_store() {
		const shop = await this.client.get(
			`https://pd.na.a.pvp.net/store/v2/storefront/${this.puuid}`,
			{
				headers: {
					"X-Riot-Entitlements-JWT": this.riot_entitlement,
					Authorization: `Bearer ${this.riot_token}`,
				},
			}
		);
		const skins = shop.data.SkinsPanelLayout;

		return {
			time_remaining: format_seconds(
				skins.SingleItemOffersRemainingDurationInSeconds
			),
			offers: await this.format_store_items(skins.SingleItemOffers),
		};
	}
}

async function run() {
	if (!__riot_username || !__riot_password) {
		console.error("failed to grab creds from .env");
		return;
	}

	const me = new User();
	console.log(await me.get_store());
}

run();
