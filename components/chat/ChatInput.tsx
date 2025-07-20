"use client";

import { useState } from "react";
import { User } from "@supabase/supabase-js";

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  error: string | null;
  user: User | null;
  sessionId: string;
}

export default function ChatInput({
  onSendMessage,
  isLoading,
  error,
  user,
  sessionId,
}: ChatInputProps) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    if (!input.trim() || isLoading || !user || !sessionId) return;
    onSendMessage(input);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-yellow-400/20 p-4">
      <div className="flex space-x-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={user ? "Type your message..." : "Loading user..."}
          disabled={isLoading || !user || !sessionId}
          className="flex-1 px-4 py-3 bg-black/40 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400/50 transition-all duration-300 disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={isLoading || !input.trim() || !user || !sessionId}
          className="bg-gradient-to-r from-yellow-400 to-yellow-600 hover:from-yellow-300 hover:to-yellow-500 text-black font-semibold px-6 py-3 rounded-lg transition-all duration-300 transform hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none shadow-lg shadow-yellow-400/25"
        >
          Send
        </button>
      </div>

      {error && (
        <div className="mt-3 bg-red-500/20 border border-red-500/40 text-red-300 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}
    </div>
  );
}