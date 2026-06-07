import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

// ─── UserProfile sub-state ────────────────────────────────────────────────────

export interface UserProfileState {
  threadId: string;
  name: string;
  birthDate: string;
  birthTime: string;
  birthCity: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

// ─── BirthChart sub-state ─────────────────────────────────────────────────────

export interface PlanetPositionState {
  name: string;
  longitude: number;
  zodiacSign: string;
  degree: number;
  minute: number;
  formatted: string;
  isRetrograde: boolean;
}

export interface BirthChartState {
  sun: PlanetPositionState;
  moon: PlanetPositionState;
  ascendant: { longitude: number; zodiacSign: string; formatted: string };
  midheaven: { longitude: number; zodiacSign: string; formatted: string };
  planets: PlanetPositionState[];
  houses: { number: number; longitude: number; zodiacSign: string; formatted: string }[];
  calculatedAt: string;
}

// ─── LangGraph State Annotation ───────────────────────────────────────────────

export const AgentState = Annotation.Root({
  // Messages with built-in reducer that appends new messages
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // User profile — last-write wins
  userProfile: Annotation<UserProfileState | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Birth chart — last-write wins
  birthChart: Annotation<BirthChartState | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
