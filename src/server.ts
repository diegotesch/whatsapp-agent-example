import "dotenv/config";
import express from "express";
import qrcode from "qrcode-terminal";
/** whatsapp-web.js é CJS; com `"type":"module"` o Node não aceita named imports directos. */
import wwebjs from "whatsapp-web.js";
import { listMediaFromOutputs, outputsToWhatsappText, runFlow } from "flow-expert/agent-client";

const { Client, LocalAuth, MessageMedia } = wwebjs;

const PORT = Number(process.env.PORT) || 8787;
const FLOW_EXPERT_URL = (process.env.FLOW_EXPERT_URL || "http://localhost:5173").replace(/\/$/, "");
const FLOW_EXPERT_WORKSPACE = process.env.FLOW_EXPERT_WORKSPACE || "default";
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || ".wwebjs_auth";
const IGNORE_GROUPS = (process.env.WHATSAPP_IGNORE_GROUPS || "true").toLowerCase() === "true";

let whatsappReady = false;

function userIdFromMessage(from: string): string {
  const id = from.replace(/@c\.us$|@s\.whatsapp\.net$/i, "");
  return `wa:${id}`;
}

const app = express();
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-flow-agent",
    transport: "whatsapp-web.js",
    whatsapp: whatsappReady ? "ready" : "starting_or_needs_qr",
    flowExpert: { url: FLOW_EXPERT_URL, workspace: FLOW_EXPERT_WORKSPACE },
  });
});
app.listen(PORT, () => {
  console.log(`HTTP health: http://localhost:${PORT}/health`);
  console.log("[agent] A iniciar WhatsApp Web (escaneia o QR quando aparecer)…");
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

client.on("qr", (qr) => {
  console.log("Escaneie o QR no telemóvel (WhatsApp → Aparelhos ligados → Ligar aparelho)");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("[wweb] sessão autenticada");
});

client.on("auth_failure", (msg) => {
  console.error("[wweb] falha de autenticação:", msg);
});

client.on("disconnected", (reason) => {
  console.warn("[wweb] desligado:", reason);
});

client.on("ready", () => {
  whatsappReady = true;
  console.log("[wweb] pronto — a escutar mensagens de texto (1:1" + (IGNORE_GROUPS ? ", grupos ignorados" : ", grupos incluídos") + ")");
  console.log(`[wweb] flow-expert → ${FLOW_EXPERT_URL} workspace=${FLOW_EXPERT_WORKSPACE}`);
});

client.on("message", async (msg) => {
  try {
    console.log("message", msg);
    if (msg.fromMe) {
      return;
    }
    if (msg.from.includes("broadcast") || msg.from === "status@broadcast") {
      return;
    }
    if (IGNORE_GROUPS && msg.from.endsWith("@g.us")) {
      return;
    }
    if (msg.type !== "chat") {
      return;
    }
    const text = (msg.body || "").trim();
    if (!text) {
      return;
    }

    const userId = userIdFromMessage(msg.from);
    const result = await runFlow({
      baseUrl: FLOW_EXPERT_URL,
      workspace: FLOW_EXPERT_WORKSPACE,
      userId,
      text,
      reset: false,
    });

    if (result.error) {
      await msg.reply(`Erro no fluxo: ${result.error.message}`.slice(0, 4096));
      return;
    }
    const reply = outputsToWhatsappText(result.outputs);
    if (reply.trim() !== "") {
      await msg.reply(reply.slice(0, 4090));
    }
    for (const m of listMediaFromOutputs(result.outputs)) {
      try {
        const media = await MessageMedia.fromUrl(m.url, { unsafeMime: true });
        await client.sendMessage(msg.from, media);
      } catch (e) {
        console.error("[wweb] mídia", m.url, e);
        try {
          await msg.reply(m.url);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("[message]", m);
    try {
      await msg.reply(`Erro: ${m.slice(0, 500)}`);
    } catch {
      /* ignore */
    }
  }
});

void client.initialize().catch((e) => {
  console.error("client.initialize()", e);
  process.exit(1);
});
