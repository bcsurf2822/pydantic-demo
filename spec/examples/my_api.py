import sys
import os
import json
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Depends, Security
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from httpx import AsyncClient

# Add the parent directory to sys.path to import from Pydantic_Tutorial
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Load environment variables from Pydantic_Tutorial/.env
project_root = Path(__file__).resolve().parent.parent
dotenv_path = project_root / 'Pydantic_Tutorial' / '.env'
load_dotenv(dotenv_path, override=True)

# Now you can import from Pydantic_Tutorial
from Pydantic_Tutorial.agent import agent, search
from Pydantic_Tutorial.clients import settings, get_supabase_client, get_openai_client, get_mem0_client
from Pydantic_Tutorial.dependencies import AgentDependencies

# Import Pydantic AI types
from pydantic_ai import Agent, ModelRequestNode
from pydantic_ai.messages import (
    PartStartEvent,
    PartDeltaEvent,
    TextPartDelta
)

# Import database utilities
from db_utils import (
    fetch_conversation_history,
    convert_history_to_pydantic_format,
    create_conversation,
    store_message,
    update_conversation_title
)


# We now define clients as None
embeddings_client = None
supabase = None
http_client = None
title_agent = None
mem0_client = None

# Define the lifespan context manager (Best practice)
# Fast API we have concept of lifespan to create clients 
# way to create client in every request w/oo havin gto create in every request

@asynccontextmanager
async def lifespan(app: FastAPI):
    global embeddings_client, supabase, http_client, title_agent, mem0_client

    # Startup: Initialize clients
    embeddings_client = get_openai_client()
    supabase = get_supabase_client()
    http_client = AsyncClient()
    title_agent = Agent('openai:gpt-4-turbo')
    mem0_client = get_mem0_client()

    # Yield control back to FastAPI
    yield

    # Shutdown: Clean up clients
    if http_client:
        await http_client.aclose()


# Initialize FastAPI Application
app = FastAPI(lifespan=lifespan)
security = HTTPBearer()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response Models
class AgentRequest(BaseModel):
    query: str
    user_id: str
    request_id: str
    session_id: str

class AgentResponse(BaseModel):
    success: bool
    error: Optional[str] = None

# Verify token function
async def verify_token(credentials: HTTPAuthorizationCredentials = Security(security)) -> Dict[str, Any]:
    """
    Verify the JWT token from Supabase / Return User information

    Args: credentials: The HTTP Authorization Credentials containing the bearer token

    Returns: Dict[str, Any] - The user information from Supabase

    Raises: HTTPException(401) - If the token is invalid or cannot be verified
    """
    try:
        # Extract the token from the credentials
        token = credentials.credentials
        
        global http_client
        if not http_client:
            raise HTTPException(status_code=500, detail="HTTP client not initialized")
        
        # Get Supabase URL and anon key from environment variables
        # Should match Environment Variable names used in project
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")

        # Create Supabase client
        response = await http_client.get(f"{supabase_url}/auth/v1/user", headers={"Authorization": f"Bearer {token}", "apikey": supabase_anon_key})

        # Check if the response is successful
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        # Parse the response JSON
        user_data = response.json()
        return user_data
    except Exception as e:
        print(f"[AGENT_API-VERIFY_TOKEN] Error verifying token: {str(e)}")
        raise HTTPException(status_code=401, detail="Invalid token")
        
       
# Routes
@app.post("/api/pydantic-agent")
async def pydantic_agent(request: AgentRequest, user: Dict[str, Any] = Depends(verify_token)):
    # Verify user ID in the request matches the user ID from the token
    if request.user_id != user.get("id"):
        raise HTTPException(status_code=403, detail="Unauthorized, User ID does not match the authenticated user")
    
    try:
        session_id = request.session_id
        conversation_record = None
        conversation_title = None

        # check if sess_id is empty, create a new conversation if needed
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())
            # create a new conversation record
            conversation_record = await create_conversation(supabase, request.user_id, session_id)

        # Store users query right away
        await store_message(supabase, session_id=session_id, message_type="human", content=request.query)

        # Fetch Conversation History from DB 
        conversation_history = await fetch_conversation_history(supabase, session_id)

        # Convert conversation history into framework format (Pydantic Here)
        pydantic_messages = await convert_history_to_pydantic_format(conversation_history)

        # Retrieve user's memories with Mem0
        relevant_memories = await mem0_client.search(query=request.query, user_id=request.user_id, limit=3)
        memories_str = "\n".join(f"- {entry['memory']}" for entry in relevant_memories['results'])

        # Start title generation in parallel (asyncio) if this is a new conversation - generates title at same time
        title_task = None
        if conversation_record:
            # Generate conversation title using the title agent
            async def generate_title():
                try:
                    result = await title_agent.run(f"Generate a short title for this conversation: {request.query}")
                    return result.output if hasattr(result, 'output') else str(result)
                except Exception as e:
                    print(f"[AGENT_API-GENERATE_TITLE] Error generating title: {str(e)}")
                    return f"Conversation about: {request.query[:50]}..."
            title_task = asyncio.create_task(generate_title())

        async def stream_response():
            # Process title result if it exists (IN BACKGROUND)
            nonlocal conversation_title

            # Use the global HTTP Client Here
            agent_deps = AgentDependencies(
                http_client=http_client,
                embedding_client=embeddings_client,
                supabase=supabase,
                settings=settings,
                memories=memories_str
            )

            # Run Agent with user prompt and the chat history this is the same as streamlit where we can see the agent thinking and typing out its response in rewal time (Cannot do this in N8N)
            async with agent.iter(request.query, deps=agent_deps, message_history=pydantic_messages) as run:
                full_response = ""
                async for node in run:
                    if isinstance(node, ModelRequestNode):
                        # A model request node => We can stream tokens from the model's request
                        async with node.stream(run.ctx) as request_stream:
                            async for event in request_stream:
                                if isinstance(event, PartStartEvent) and event.part.part_kind == 'text':
                                    yield json.dumps({"text": event.part.content}).encode('utf-8') + b'\n'
                                    full_response += event.part.content
                                elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                                    delta = event.delta.content_delta
                                    yield json.dumps({"text": full_response}).encode('utf-8') + b'\n'
                                    full_response += delta

            # After streaming is complete store the full response in the database
            message_data =  run.result.new_messages_json()
            
            # Store agent response
            await store_message(supabase, session_id=session_id, message_type="ai", content=full_response, message_data=message_data, data={"request_id": request.request_id})


            # Wait for title gen to compelete if it's running
            if title_task:
                title_result = await title_task
                conversation_title = title_result

            # Update conversation title in database
            if conversation_title:
                await update_conversation_title(supabase, session_id, conversation_title)

            # Send the final title in the last chunk

            final_data = {
                "text": "",
                "session_id": session_id,
                "conversation_title": conversation_title,
                "complete": True,
            }

            yield json.dumps(final_data).encode('utf-8') + b'\n'

        # Store conversation memories after streaming is complete
        try:
            memory_messages = [
                {"role": "user", "content": request.query},
                # Including AI Response from the agent often leads to much verbose memories however this is an example of how to do it
                {"role": "assistant", "content": full_response},
            ]

            # Store memories in the database
            mem0_client.add(memory_messages, user_id=request.user_id)
        except Exception as e:
            print(f"[AGENT_API-MEMORY_STORAGE] Error storing memories: {str(e)}")

        return StreamingResponse(stream_response(), media_type="text/plain")

    except Exception as e:
        print(f"Error in pydantic_agent: {str(e)}")
        # Store error message in conversation if session_id is provided
        if request.session_id:
            await store_message(supabase, session_id=request.session_id, message_type="ai", content="I appologize, I'm having trouble processing your request. Please try again later.", data={"error": str(e), "request_id": request.request_id})
        raise HTTPException(status_code=500, detail=f"Error processing request: {str(e)}")
    

# Run the app with uvicorn and host it on localhost:8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)