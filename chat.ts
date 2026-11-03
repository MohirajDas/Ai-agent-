import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { env } from "@/lib/env.server";

const bodySchema = z.object({
  mode: z.enum(["general", "code", "study", "hindi"]),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(6000),
      }),
    )
    .min(1)
    .max(16),
});

const BASE = [
  "You are Aaroh, a personal AI agent people install on Android and Windows.",
  "Be direct, concrete, and calm. Lead with the answer.",
  "Match the user's language — Hindi, English, or a natural mix. Use Devanagari when the user writes in Hindi.",
  "Do not claim to be Grok, xAI, ChatGPT, or a human. If you are unsure, say so.",
  "Use markdown when it helps (short lists, fenced code). Do not use emoji.",
].join(" ");

const MODE_NOTE: Record<z.infer<typeof bodySchema>["mode"], string> = {
  general: "Help with whatever they ask. Keep the useful detail, cut the filler.",
  code: "You are in code mode. Prefer correct, runnable code. Name the language. Explain only what is non-obvious.",
  study:
    "You are in study mode. Teach in clear steps. After the explanation, offer one short check question — only one.",
  hindi:
    "You are in Hindi mode. Reply in natural Hindi using Devanagari. Keep a technical English word only when a Hindi word would confuse.",
};

const stamps: number[] = [];

function allowRequest() {
  const now = Date.now();
  while (stamps.length && now - (stamps[0] ?? 0) > 60_000) stamps.shift();
  if (stamps.length >= 15) return false;
  stamps.push(now);
  return true;
}

function withTimeout(signals: AbortSignal[]) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function deltaFromLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const json = JSON.parse(data) as {
      choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
    };
    const choice = json.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = env("XAI_API_KEY");
        if (!apiKey) {
          return Response.json(
            { error: "Aaroh cannot reach the model in this environment." },
            { status: 503 },
          );
        }
        if (!allowRequest()) {
          return Response.json({ error: "Too many messages. Wait a moment and try again." }, { status: 429 });
        }

        let json: unknown;
        try {
          json = await request.json();
        } catch {
          return Response.json({ error: "That message could not be read." }, { status: 400 });
        }
        const parsed = bodySchema.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "Send a shorter message and try again." }, { status: 400 });
        }
        const messages = parsed.data.messages.slice(-16);
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user") {
          return Response.json({ error: "The last message has to be yours." }, { status: 400 });
        }

        const signal = withTimeout([request.signal, AbortSignal.timeout(55_000)]);
        let upstream: Response;
        try {
          upstream = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "grok-4.5",
              stream: true,
              max_tokens: 1100,
              temperature: 0.6,
              messages: [
                { role: "system", content: `${BASE} ${MODE_NOTE[parsed.data.mode]}` },
                ...messages,
              ],
            }),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return new Response(null, { status: 499 });
          }
          console.error("aaroh upstream failed");
          return Response.json({ error: "Aaroh could not reach the model." }, { status: 502 });
        }

        if (!upstream.ok) {
          const errText = await upstream.text();
          let code = "";
          try {
            code = (JSON.parse(errText) as { code?: string }).code ?? "";
          } catch {
            code = "";
          }
          console.error("aaroh upstream status", upstream.status, code);
          if (code.includes("spending-limit")) {
            return Response.json(
              {
                error:
                  "Model credits are used up on this account. Add credits in Grok, then send again.",
              },
              { status: 402 },
            );
          }
          const status = upstream.status === 429 ? 429 : 502;
          const error =
            upstream.status === 429
              ? "The model is busy. Wait a moment and try again."
              : "Aaroh could not complete that reply.";
          return Response.json({ error }, { status });
        }

        const contentType = upstream.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = (await upstream.json()) as {
            choices?: { message?: { content?: unknown } }[];
          };
          const text = body.choices?.[0]?.message?.content;
          return new Response(typeof text === "string" ? text : "", {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
          });
        }

        const encoder = new TextEncoder();
        const reader = upstream.body?.getReader();
        if (!reader) {
          return Response.json({ error: "Aaroh received an empty reply." }, { status: 502 });
        }
        const decoder = new TextDecoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let buffer = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  const delta = deltaFromLine(line);
                  if (delta) controller.enqueue(encoder.encode(delta));
                }
              }
              const tail = deltaFromLine(buffer);
              if (tail) controller.enqueue(encoder.encode(tail));
            } catch (error) {
              if (!(error instanceof Error && error.name === "AbortError")) {
                console.error("aaroh stream interrupted");
              }
            } finally {
              controller.close();
              reader.releaseLock();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
