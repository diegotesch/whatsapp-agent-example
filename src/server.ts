import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import qrcode from "qrcode-terminal";
/** whatsapp-web.js é CJS; com `"type":"module"` o Node não aceita named imports directos. */
import wwebjs from "whatsapp-web.js";
import {
  extractBodyAndOptionsForChat,
  listMediaFromOutputs,
  outputsToWhatsappText,
  resolveMediaUrlToAbsolute,
  runFlow,
} from "flow-expert/agent-client";

const __agentDir = path.dirname(fileURLToPath(import.meta.url));
/** Sempre o `.env` na raiz deste pacote (não depende do CWD; sobrepõe variáveis herdadas do shell). */
dotenv.config({ path: path.resolve(__agentDir, "..", ".env"), override: true });

const { Client, LocalAuth, MessageMedia, Buttons } = wwebjs;

const PORT = Number(process.env.PORT) || 8787;
const FLOW_EXPERT_URL = (process.env.FLOW_EXPERT_URL || "http://localhost:5173").replace(/\/$/, "");
const FLOW_EXPERT_WORKSPACE = process.env.FLOW_EXPERT_WORKSPACE || "default";
/** Token Bearer para `POST /api/run` — lido deste pacote após `dotenv.config` (não confundir com o `.env` só do flow-expert studio). */
const FLOW_EXPERT_API_KEY = (process.env.FLOW_EXPERT_API_KEY ?? "").trim();
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
  if (!FLOW_EXPERT_API_KEY) {
    console.warn("[wweb] FLOW_EXPERT_API_KEY vazio no .env deste agente — /api/run responderá 401.");
  } else {
    console.log(`[wweb] Bearer carregado (${FLOW_EXPERT_API_KEY.slice(0, 6)}…)`);
  }
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
    let result;
    try {
      result = await runFlow({
        baseUrl: FLOW_EXPERT_URL,
        workspace: FLOW_EXPERT_WORKSPACE,
        userId,
        text,
        reset: false,
        apiKey: FLOW_EXPERT_API_KEY || undefined,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await msg.reply(`Erro ao contactar o motor Flow Expert:\n${m.slice(0, 3500)}`);
      return;
    }

    if (result.error) {
      const em =
        (result.error.message && result.error.message.trim()) ||
        result.error.code ||
        "erro desconhecido no fluxo";
      await msg.reply(`Erro no fluxo:\n${em}`.slice(0, 4096));
      return;
    }

    const { body, options } = extractBodyAndOptionsForChat(result.outputs, { baseUrl: FLOW_EXPERT_URL });
    const useButtons = options.length >= 1 && options.length <= 3;
    let displayBody = body;
    if (useButtons && (displayBody === "(sem texto na resposta do fluxo)" || displayBody.trim() === "")) {
      displayBody = "Escolha uma opção:";
    }
    if (useButtons) {
      const specs = options.slice(0, 3).map((b) => ({ body: b.trim().slice(0, 200) }));
      await client.sendMessage(
        msg.from,
        new Buttons(displayBody.slice(0, 1024), specs, "", ""),
      );
    } else {
      const reply = outputsToWhatsappText(result.outputs, { baseUrl: FLOW_EXPERT_URL });
      if (reply.trim() !== "") {
        await msg.reply(reply.slice(0, 4090));
      }
    }
    for (const m of listMediaFromOutputs(result.outputs)) {
      try {
        const fullUrl = resolveMediaUrlToAbsolute(m.url, FLOW_EXPERT_URL);
        const media = await MessageMedia.fromUrl(fullUrl, { unsafeMime: true });
        await client.sendMessage(msg.from, media);
      } catch (e) {
        console.error("[wweb] mídia", m.url, e);
        try {
          await msg.reply(resolveMediaUrlToAbsolute(m.url, FLOW_EXPERT_URL));
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
