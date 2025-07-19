
'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<any>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const router = useRouter()
  const supabase = createClient()

  // Get user and create session ID
  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/auth/login')
        return
      }
      
      setUser(user)
      // Generate session_id in format: {user_id}~{random_string} to match existing conversations
      const randomSuffix = Math.random().toString(36).substring(2, 12)
      const sessionId = `${user.id}~${randomSuffix}`
      setSessionId(sessionId)
      console.log('[CHAT-TEST] Session ID generated:', sessionId)
    }
    
    getUser()
  }, [supabase, router])

  // Create conversation if it doesn't exist
  const ensureConversation = async () => {
    try {
      const { data, error } = await supabase
        .from('conversations')
        .select('session_id')
        .eq('session_id', sessionId)
        .single()

      if (error && error.code === 'PGRST116') {
        // Conversation doesn't exist, create it
        const { error: insertError } = await supabase
          .from('conversations')
          .insert({
            session_id: sessionId,
            user_id: user.id,
            title: null, // Will be auto-generated
            metadata: {}
          })

        if (insertError) {
          console.error('[CHAT-TEST] Error creating conversation:', insertError)
          throw new Error(`Failed to create conversation: ${insertError.message}`)
        }
        console.log('[CHAT-TEST] Conversation created:', sessionId)
      } else if (error) {
        console.error('[CHAT-TEST] Error checking conversation:', error)
        throw new Error(`Database error: ${error.message}`)
      } else {
        console.log('[CHAT-TEST] Conversation already exists:', sessionId)
      }
    } catch (err) {
      console.error('[CHAT-TEST] ensureConversation failed:', err)
      throw err
    }
  }

  const sendMessage = async () => {
    if (!input.trim() || !user || !sessionId) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString()
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)
    setError(null)

    try {
      // Ensure conversation exists before sending message
      await ensureConversation()
      
      // Test API connection with correct payload format
      const apiUrl = process.env.NEXT_PUBLIC_PYDANTIC_AGENT_API_URL || 'http://localhost:8001/api/pydantic-agent'
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
      
      const payload = {
        query: userMessage.content,
        user_id: user.id,
        request_id: requestId,
        session_id: sessionId
      }
      
      console.log('[CHAT-TEST] Sending request to:', apiUrl)
      console.log('[CHAT-TEST] Payload:', payload)

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      })

      console.log('[CHAT-TEST] Response status:', response.status)
      console.log('[CHAT-TEST] Response headers:', Object.fromEntries(response.headers.entries()))

      if (!response.ok) {
        const errorText = await response.text()
        console.error('[CHAT-TEST] Error response:', errorText)
        throw new Error(`API Error: ${response.status} - ${errorText}`)
      }

      // Handle streaming response
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body reader available')
      }

      // Create assistant message with empty content that we'll update
      const assistantMessageId = (Date.now() + 1).toString()
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString()
      }

      // Add empty assistant message to show streaming is starting
      setMessages(prev => [...prev, assistantMessage])

      const decoder = new TextDecoder()
      let accumulatedText = ''
      
      try {
        while (true) {
          const { done, value } = await reader.read()
          
          if (done) {
            console.log('[CHAT-TEST] Stream complete')
            break
          }

          const chunk = decoder.decode(value, { stream: true })
          console.log('[CHAT-TEST] Received chunk:', chunk)

          // Split chunk by newlines to handle multiple JSON objects
          const lines = chunk.split('\n').filter(line => line.trim())
          
          for (const line of lines) {
            try {
              const data = JSON.parse(line)
              
              // Check if this is a completion signal
              if (data.complete === true) {
                console.log('[CHAT-TEST] Received completion signal, keeping final text:', accumulatedText)
                break
              }
              
              // Only update if text is not empty (to avoid clearing at the end)
              if (data.text !== undefined && data.text !== '') {
                accumulatedText = data.text
                console.log('[CHAT-TEST] Updated text:', accumulatedText)
                
                // Update the assistant message content in real-time
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId 
                    ? { ...msg, content: accumulatedText }
                    : msg
                ))
              } else if (data.text === '') {
                console.log('[CHAT-TEST] Ignoring empty text to preserve accumulated content')
              }
            } catch (parseError) {
              console.warn('[CHAT-TEST] Could not parse line as JSON:', line)
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      
    } catch (err) {
      console.error('[CHAT-TEST] Request failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to send message')
      
      // Add error message to chat
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error occurred'}`,
        timestamp: new Date().toISOString()
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const clearChat = () => {
    setMessages([])
    setError(null)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-purple-950 to-black text-white">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-yellow-400/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl"></div>
      </div>

      {/* Navigation */}
      <nav className="relative border-b border-yellow-400/20 backdrop-blur-xl bg-black/20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => router.push('/')}
                className="text-yellow-400 hover:text-yellow-300 transition-colors"
              >
                ← Back to Dashboard
              </button>
              <h1 className="text-xl font-bold text-yellow-400">Chat Test</h1>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={clearChat}
                className="bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 px-4 py-2 rounded-lg transition-all duration-300"
              >
                Clear Chat
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Chat Container */}
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-black/40 backdrop-blur-xl border border-yellow-400/20 rounded-2xl overflow-hidden">
          
          {/* Messages Area */}
          <div className="h-96 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-gray-400 py-12">
                <p className="text-lg mb-2">Chat Test Interface</p>
                <p className="text-sm">Send a message to test your Pydantic agent API connection</p>
                <p className="text-xs mt-2 text-yellow-400">API: {process.env.NEXT_PUBLIC_PYDANTIC_AGENT_API_URL || 'http://localhost:8001/api/pydantic-agent'}</p>
                {user && <p className="text-xs mt-1 text-green-400">User: {user.email}</p>}
                {sessionId && <p className="text-xs mt-1 text-purple-400">Session: {sessionId}</p>}
              </div>
            )}
            
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                    message.role === 'user'
                      ? 'bg-gradient-to-r from-yellow-400 to-yellow-600 text-black'
                      : message.content.startsWith('Error:')
                      ? 'bg-red-500/20 border border-red-500/40 text-red-300'
                      : 'bg-purple-500/20 border border-purple-500/40 text-white'
                  }`}
                >
                  <p className="text-sm">{message.content}</p>
                  <p className="text-xs opacity-70 mt-1">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-purple-500/20 border border-purple-500/40 text-white max-w-xs lg:max-w-md px-4 py-2 rounded-lg">
                  <div className="flex items-center space-x-2">
                    <div className="animate-spin w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full"></div>
                    <span className="text-sm">Agent is thinking...</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input Area */}
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
                onClick={sendMessage}
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
        </div>

        {/* Debug Info */}
        <div className="mt-6 bg-black/20 backdrop-blur-xl border border-gray-600/20 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Debug Information</h3>
          <div className="text-xs text-gray-400 space-y-1">
            <p><span className="text-yellow-400">API URL:</span> {process.env.NEXT_PUBLIC_PYDANTIC_AGENT_API_URL || 'http://localhost:8001/api/pydantic-agent'}</p>
            <p><span className="text-yellow-400">User ID:</span> {user?.id || 'Loading...'}</p>
            <p><span className="text-yellow-400">Session ID:</span> {sessionId || 'Generating...'}</p>
            <p><span className="text-yellow-400">Messages:</span> {messages.length}</p>
            <p><span className="text-yellow-400">Status:</span> {isLoading ? 'Loading...' : 'Ready'}</p>
          </div>
        </div>
      </div>
    </div>
  )
}