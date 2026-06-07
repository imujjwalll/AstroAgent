import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { HumanMessage } from "@langchain/core/messages";
import { connectMongoDB, UserProfile } from "./db/mongo";
import { createGraph } from "./graph/agent";
import { z } from "zod";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? process.env.FRONTEND_URL || "http://localhost:5173"
    : "*",
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));

// ─── MongoDB Native Client (for LangGraph checkpointer) ───────────────────────

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/astroagent";
const mongoClient = new MongoClient(mongoUri);

// ─── LangGraph ────────────────────────────────────────────────────────────────

let graph: ReturnType<typeof createGraph>;

// ─── Validation Schemas ───────────────────────────────────────────────────────

const profileSchema = z.object({
  threadId: z.string().min(1),
  name: z.string().min(1).max(100),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
  birthTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM format"),
  birthCity: z.string().min(1).max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  threadId: z.string().min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// POST /api/profile — Save or update user profile
app.post("/api/profile", async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = profileSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: "Validation failed",
        details: validation.error.errors,
      });
      return;
    }

    const data = validation.data;

    // Upsert the profile
    const profile = await UserProfile.findOneAndUpdate(
      { threadId: data.threadId },
      {
        threadId: data.threadId,
        name: data.name,
        birthDate: data.birthDate,
        birthTime: data.birthTime,
        birthCity: data.birthCity,
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      profile: {
        threadId: profile.threadId,
        name: profile.name,
        birthCity: profile.birthCity,
        timezone: profile.timezone,
      },
    });
  } catch (error) {
    console.error("Profile save error:", error);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

// GET /api/profile/:threadId — Fetch user profile
app.get("/api/profile/:threadId", async (req: Request, res: Response): Promise<void> => {
  try {
    const { threadId } = req.params;
    const profile = await UserProfile.findOne({ threadId: String(threadId) });

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    res.json({ profile });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// POST /api/chat — SSE streaming chat
app.post("/api/chat", async (req: Request, res: Response): Promise<void> => {
  // Validate input
  const validation = chatSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: "Invalid request", details: validation.error.errors });
    return;
  }

  const { message, threadId } = validation.data;
  // Sanitize threadId to prevent NoSQL injection
  const safeThreadId = String(threadId).replace(/[^\w-]/g, "");

  // ── Set SSE headers ──
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    console.log(`[DEBUG] Incoming chat request for thread: ${safeThreadId}`);
    // Load user profile from MongoDB
    const profile = await UserProfile.findOne({ threadId: safeThreadId });

    // Prepare initial state
    const initialState: Record<string, unknown> = {
      messages: [new HumanMessage(message)],
    };

    if (profile) {
      initialState.userProfile = {
        threadId: profile.threadId,
        name: profile.name,
        birthDate: profile.birthDate,
        birthTime: profile.birthTime,
        birthCity: profile.birthCity,
        latitude: profile.latitude,
        longitude: profile.longitude,
        timezone: profile.timezone,
      };
    }

    const config = {
      configurable: { thread_id: safeThreadId },
      streamMode: "messages" as const,
    };

    console.log(`[DEBUG] Graph execution start for thread: ${safeThreadId}`);
    // Stream events from LangGraph
    const stream = await graph.streamEvents(initialState, {
      version: "v2",
      configurable: { thread_id: safeThreadId },
    });

    for await (const event of stream) {
      if (res.writableEnded) break;

      const { event: eventType, name, data } = event;

      // Stream AI tokens
      if (eventType === "on_chat_model_stream") {
        const chunk = data?.chunk;
        const content = chunk?.content;
        if (content && typeof content === "string" && content.length > 0) {
          console.log(`[DEBUG] SSE chunk sent: ${content.substring(0, 20).replace(/\n/g, '\\n')}`);
          sendEvent("token", { content });
        }
      }

      // Tool start — notify client which tool is running
      if (eventType === "on_tool_start") {
        console.log(`[DEBUG] Tool execution start: ${name}`);
        sendEvent("tool_start", {
          tool: name,
          input: data?.input,
        });
      }

      // Tool end — notify client tool finished
      if (eventType === "on_tool_end") {
        console.log(`[DEBUG] Tool execution end: ${name} | Success: ${!data?.output?.toString().includes('"error"')}`);
        sendEvent("tool_end", {
          tool: name,
          success: !data?.output?.toString().includes('"error"'),
        });
      }

      // Chat Model End
      if (eventType === "on_chat_model_end") {
        console.log(`[DEBUG] LLM response received/ended for thread: ${safeThreadId}`);
      }
    }

    console.log(`[DEBUG] Stream completed normally for thread: ${safeThreadId}`);
    sendEvent("done", { finished: true });
    res.end();
  } catch (error) {
    console.error(`[DEBUG] Chat stream error:`, error);
    
    let message = "I'm sorry, I encountered an unexpected error while processing your request.";
    const rawError = error instanceof Error ? error.message : String(error);
    
    // Intercept upstream provider crashes (token limits, EngineCore, rate limits)
    if (rawError.includes("EngineCore") || rawError.includes("Upstream") || rawError.includes("rate limit") || rawError.includes("context length")) {
      message = "The astrological analysis grew too extensive and I hit a processing limit. Please try asking a more focused question, such as 'What are my career insights?' or 'What is my Moon sign?'";
    }

    if (!res.writableEnded) {
      sendEvent("error", { message });
      res.end();
    }
  }
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Connect Mongoose (for UserProfile model)
    await connectMongoDB();

    // Connect native MongoClient (for LangGraph checkpointer)
    await mongoClient.connect();
    console.log("✅ Native MongoDB client connected");

    // Initialize LangGraph
    graph = createGraph(mongoClient);

    // Start Express
    app.listen(PORT, () => {
      console.log(`🚀 AstroAgent backend running on http://localhost:${PORT}`);
      console.log(`📡 SSE chat endpoint: POST http://localhost:${PORT}/api/chat`);
    });
  } catch (error) {
    console.error("❌ Startup failed:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await mongoClient.close();
  process.exit(0);
});

start();
