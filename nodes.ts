import { ChatOpenAI } from "@langchain/openai";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "./state";
import { tools } from "../tools";

// ─── LLM Setup ────────────────────────────────────────────────────────────────

const llm = new ChatOpenAI({
  modelName: "openrouter/free",
  temperature: 0.7,
  streaming: true,
  openAIApiKey: process.env.OPENROUTER_API_KEY,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

const llmWithTools = llm.bindTools(tools);

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(state: AgentStateType): string {
  const profile = state.userProfile;
  const chart = state.birthChart;

  let profileSection = "";
  if (profile) {
    profileSection = `
## User's Birth Profile
- **Name**: ${profile.name}
- **Date of Birth**: ${profile.birthDate}
- **Time of Birth**: ${profile.birthTime}
- **Birth City**: ${profile.birthCity}
- **Coordinates**: ${profile.latitude}°N, ${profile.longitude}°E
- **Timezone**: ${profile.timezone}
`;
  }

  let chartSection = "";
  if (chart) {
    chartSection = `
## Calculated Birth Chart
- **Sun**: ${chart.sun.formatted}${chart.sun.isRetrograde ? " ℞" : ""}
- **Moon**: ${chart.moon.formatted}${chart.moon.isRetrograde ? " ℞" : ""}
- **Ascendant (Rising)**: ${chart.ascendant.formatted}
- **Midheaven (MC)**: ${chart.midheaven.formatted}
${chart.planets
  .filter((p) => !["Sun", "Moon"].includes(p.name))
  .map((p) => `- **${p.name}**: ${p.formatted}${p.isRetrograde ? " ℞" : ""}`)
  .join("\n")}
`;
  }

  return `You are AstroAgent, an expert astrologer powered by real Swiss Ephemeris calculations. You provide accurate, insightful, and personalized astrological readings.

## Your Capabilities
- Calculate precise birth charts using real planetary positions (not generic descriptions)
- Geocode birth cities to exact coordinates and timezones
- Interpret planetary placements, aspects, houses, and their meaning
- Provide sun sign, moon sign, rising sign analysis
- Discuss transits, compatibility, and life themes

## Your Approach
- Always use real calculations — never make up astrological data
- If you need to calculate a birth chart, houses, midheaven (MC), or any planetary placements, call the \`compute_birth_chart\` tool first
- If you need to check today's transits, call the \`get_daily_transits\` tool (requires the full natal chart object)
- If you need to geocode a city, call the \`geocode_city\` tool first
- Be warm, insightful, and specific — personalize interpretations to the user's actual chart
- Use the ℞ symbol to indicate retrograde planets
- Express degrees as e.g. "15°23' Scorpio"

## Graceful Error Handling
- **Future Dates & Invalid Years**: If the user asks for a birth chart with a year in the future (e.g., beyond the current year) or an absurdly old year (e.g., year 100 or 1500), you MUST politely reject the request. DO NOT attempt to calculate the chart for these extreme invalid years.
- **Invalid Dates**: If a date is invalid (Feb 30, Dec 32, etc.), acknowledge the impossibility and politely ask for a valid date. DO NOT call \`compute_birth_chart\` if you already know the date is impossible.
- **Unknown Cities**: If the \`geocode_city\` tool returns an error (e.g., city not found), gracefully relay that error to the user and ask for clarification or a nearby major city. Do not crash or hallucinate coordinates.
- Never hallucinate planetary positions or chart data.

## Response Optimization (CRITICAL)
- Keep interpretations concise and structured.
- If asked for a "full chart" or multiple complex insights, summarize the most important themes rather than writing a massive essay. 
- You operate under strict token limits. Do not exceed 500 words per response. Chunk your analysis if necessary by asking the user if they'd like to dive deeper into a specific area.

${profileSection}
${chartSection}

Respond in a warm, knowledgeable, and conversational tone. Use markdown formatting for clarity.`;
}

// ─── Reasoning Node ───────────────────────────────────────────────────────────

export async function reasoningNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const systemPrompt = buildSystemPrompt(state);
  const systemMessage = new SystemMessage(systemPrompt);

  // Filter to only BaseMessage instances (system goes first, then history)
  const messages: BaseMessage[] = [systemMessage, ...state.messages];

  const response = await llmWithTools.invoke(messages);

  // If the tool returned birth chart data, extract it into state
  let birthChart = state.birthChart;
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg && lastMsg.getType() === "tool" && lastMsg.name === "compute_birth_chart") {
    try {
      const parsed = JSON.parse(lastMsg.content as string);
      if (parsed) {
        birthChart = parsed;
      }
    } catch {}
  }

  return {
    messages: [response as AIMessage],
    birthChart,
  };
}

// ─── Tool Node ────────────────────────────────────────────────────────────────

export const toolNode = new ToolNode(tools);

// ─── Router Node ─────────────────────────────────────────────────────────────

export function routerNode(state: AgentStateType): "tools" | "__end__" {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1] as AIMessage;

  // If the last message has tool_calls, route to tool execution
  if (lastMessage?.tool_calls && lastMessage.tool_calls.length > 0) {
    return "tools";
  }

  // Otherwise end the graph execution
  return "__end__";
}
