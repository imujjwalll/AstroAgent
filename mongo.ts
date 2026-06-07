import mongoose, { Schema, Document } from "mongoose";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IUserProfile extends Document {
  threadId: string;
  name: string;
  birthDate: string;   // ISO date string e.g. "1990-05-15"
  birthTime: string;   // "HH:MM" 24-hour
  birthCity: string;
  latitude: number;
  longitude: number;
  timezone: string;    // IANA timezone e.g. "Asia/Kolkata"
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const UserProfileSchema = new Schema<IUserProfile>(
  {
    threadId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    birthDate: { type: String, required: true },
    birthTime: { type: String, required: true },
    birthCity: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    timezone: { type: String, required: true },
  },
  {
    timestamps: true,
    collection: "user_profiles",
  }
);

export const UserProfile = mongoose.model<IUserProfile>(
  "UserProfile",
  UserProfileSchema
);

// ─── Connection ───────────────────────────────────────────────────────────────

let isConnected = false;

export async function connectMongoDB(): Promise<void> {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  await mongoose.connect(uri, {
    dbName: "astroagent",
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  isConnected = true;
  console.log("✅ MongoDB connected");

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB connection error:", err);
    isConnected = false;
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — will reconnect on next operation");
    isConnected = false;
  });
}
