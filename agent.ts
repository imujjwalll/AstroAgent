import { StateGraph, END, START } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { MongoClient } from "mongodb";
import { AgentState } from "./state";
import { reasoningNode, toolNode, routerNode } from "./nodes";

// ─── Graph Factory ────────────────────────────────────────────────────────────

export function createGraph(mongoClient: MongoClient) {
  // Initialize MongoDB checkpointer for conversation persistence
  const checkpointer = new MongoDBSaver({ client: mongoClient });

  // Build the state graph
  const builder = new StateGraph(AgentState)
    // ── Add nodes ──
    .addNode("reasoning", reasoningNode)
    .addNode("tools", toolNode)

    // ── Entry point ──
    .addEdge(START, "reasoning")

    // ── Conditional routing from reasoning ──
    .addConditionalEdges("reasoning", routerNode, {
      tools: "tools",
      __end__: END,
    })

    // ── After tools, always go back to reasoning ──
    .addEdge("tools", "reasoning");

  // Compile with MongoDB persistence
  const graph = builder.compile({ checkpointer });

  console.log("✅ LangGraph compiled with MongoDBSaver");
  return graph;
}

export type CompiledGraph = ReturnType<typeof createGraph>;
