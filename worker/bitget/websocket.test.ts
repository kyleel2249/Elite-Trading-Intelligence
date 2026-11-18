import test from "node:test";
import assert from "node:assert/strict";
import { bitgetUtaLogin, bitgetPrivateLogin, bitgetUtaPrivateSubscriptions, handleBitgetPrivateWebSocket } from "./websocket.ts";
import { bitgetSign } from "./api.ts";

const ENV = { BITGET_API_KEY: "test-key", BITGET_API_SECRET: "test-secret", BITGET_API_PASSPHRASE: "test-pass" };

test("UTA private websocket login uses seconds and the documented /user/verify HMAC prehash", async () => {
  const login = await bitgetUtaLogin(ENV, () => 1_700_000_000_999);
  assert.equal(login.op, "login");
  assert.deepEqual(login.args[0], {
    apiKey: "test-key", passphrase: "test-pass", timestamp: "1700000000",
    sign: await bitgetSign("test-secret", "1700000000", "GET", "/user/verify", "")
  });
});

test("UTA private websocket subscribes to account, orders, positions and fills only", () => {
  assert.deepEqual(bitgetUtaPrivateSubscriptions(), [
    { instType: "UTA", topic: "account" },
    { instType: "UTA", topic: "order" },
    { instType: "UTA", topic: "position" },
    { instType: "UTA", topic: "fill" }
  ]);
});

test("private websocket relay requires operator authentication, credentials and a WebSocket upgrade", async () => {
  const unauth = await handleBitgetPrivateWebSocket(new Request("https://eti.test/api/bitget/ws/private", { headers: { upgrade: "websocket" } }), ENV);
  assert.equal(unauth.status, 401);
  const wrongOrigin = await handleBitgetPrivateWebSocket(new Request("https://eti.test/api/bitget/ws/private", { headers: { upgrade: "websocket", origin: "https://attacker.test", authorization: "Bearer master-token" } }), { ETI_EXECUTION_TOKEN: "master-token", ...ENV });
  assert.equal(wrongOrigin.status, 403);
  const authorizedEnv = { ETI_EXECUTION_TOKEN: "master-token" };
  const noCredentials = await handleBitgetPrivateWebSocket(new Request("https://eti.test/api/bitget/ws/private", {
    headers: { upgrade: "websocket", authorization: "Bearer master-token" }
  }), authorizedEnv);
  assert.equal(noCredentials.status, 503);
  const badUpgrade = await handleBitgetPrivateWebSocket(new Request("https://eti.test/api/bitget/ws/private", {
    headers: { authorization: "Bearer master-token" }
  }), { ...ENV, ...authorizedEnv });
  assert.equal(badUpgrade.status, 426);
});


test("private login isolates demo UTA and production Classic credentials", async()=>{
 const env={
  BITGET_API_KEY:"live",BITGET_API_SECRET:"live-secret",BITGET_API_PASSPHRASE:"live-pass",
  BITGET_DEMO_API_KEY:"demo",BITGET_DEMO_API_SECRET:"demo-secret",BITGET_DEMO_API_PASSPHRASE:"demo-pass",
  BITGET_CLASSIC_API_KEY:"classic",BITGET_CLASSIC_API_SECRET:"classic-secret",BITGET_CLASSIC_API_PASSPHRASE:"classic-pass"
 };
 const demo=await bitgetPrivateLogin(env,"demo","uta",()=>1_700_000_000_999);
 assert.equal(demo.args[0].apiKey,"demo");
 assert.equal(demo.args[0].sign,await bitgetSign("demo-secret","1700000000","GET","/user/verify",""));
 const classic=await bitgetPrivateLogin(env,"production","classic",()=>1_700_000_000_999);
 assert.equal(classic.args[0].apiKey,"classic");
 assert.equal(classic.args[0].sign,await bitgetSign("classic-secret","1700000000","GET","/user/verify",""));
});

test("private relay rejects unsupported environment/account combinations before connecting",async()=>{
 const response=await handleBitgetPrivateWebSocket(new Request("https://eti.test/api/bitget/ws/private?environment=demo&account=classic",{headers:{upgrade:"websocket",authorization:"Bearer master-token"}}),{ETI_EXECUTION_TOKEN:"master-token"});
 assert.equal(response.status,400);
});
