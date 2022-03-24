import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import url from "url";
import querystring from "querystring";
import dotenv from "dotenv";
import fs from "fs/promises";
import express from "express";
import cron from "node-cron";
import rateLimit from "express-rate-limit";

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
  jar: CookieJar;
  riot_entitlement: string;
  riot_token: string;
  puuid: string;

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        withCredentials: true,
        jar: this.jar,
      })
    );

    this.riot_entitlement = "";
    this.riot_token = "";
    this.puuid = "";
  }

  async login(username: string, password: string) {
    await this.jar.removeAllCookies();
    await this.client.post("https://auth.riotgames.com/api/v1/authorization", {
      client_id: "play-valorant-web-prod",
      nonce: "1",
      redirect_uri: "https://playvalorant.com/opt_in",
      response_type: "token id_token",
    });

    const res = await this.client.put(
      "https://auth.riotgames.com/api/v1/authorization",
      {
        type: "auth",
        username: username,
        password: password,
        remember: true,
        language: "en_US",
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

cron.schedule("0 0 * * *", async () => {
  await cache_skins_list();
});

async function run() {
  if (!__riot_username || !__riot_password) {
    console.error("failed to grab creds from .env");
    return;
  }

  const me = new User();

  const app = express();
  app.set("view engine", "ejs");
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      message: "You exceeded the 1 request in 1 minute limit!",
      headers: true,
    })
  );
  app.get("/", async (_, res) => {
    await me.login(__riot_username, __riot_password);
    res.render("index", await me.get_store());
  });
  app.listen(8080);
}

run();
