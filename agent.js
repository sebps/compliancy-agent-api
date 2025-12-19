import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";

// --- SETUP ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_NAME = 'agent_state.db';
const STATE_URL = process.env.STATE_URL ? path.resolve(process.env.STATE_URL) : path.resolve(__dirname, 'state', DB_NAME);

if (!fs.existsSync(path.dirname(STATE_URL))) fs.mkdirSync(path.dirname(STATE_URL), { recursive: true });

const DATA_URL = process.env.DATA_URL ? path.resolve(process.env.DATA_URL.replace('.json', '.ndjson')) : path.resolve(__dirname, 'data', 'regulations.ndjson');
const sqliteDB = new Database(STATE_URL);
sqliteDB.pragma('journal_mode = DELETE'); 

const checkpointer = new SqliteSaver(sqliteDB);
await checkpointer.setup(); 

sqliteDB.exec(`CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, query TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

let rawData = [];
try { if (fs.existsSync(DATA_URL)) rawData = fs.readFileSync(DATA_URL, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); } catch (e) {}

// --- SCHEMAS ---
const EntitySchema = z.object({
    product: z.string().nullable().describe("The specific chemical/product name."),
    usage: z.string().nullable().describe("The intended action."),
    condition: z.string().nullable().describe("Context/environment.")
});

const ComplianceSchema = z.object({
    legal: z.boolean(),
    summary: z.string(),
    risk: z.enum(["Safe", "Caution", "High Risk"])
});

const EXTRACTOR_PROMPT = `You are a Chemical Entity Extractor. Extract: 1. product 2. usage 3. condition. Return JSON.`;

const searchTool = tool(
    async ({ product }) => {
        if (!product) return "Product required.";
        const needle = product.toLowerCase().trim();
        const results = rawData.filter(r => (r.content || "").toLowerCase().includes(needle));
        if (!results.length) return "No records found.";
        return results.slice(0, 5).map(r => JSON.stringify({ product: r.name, usage: r.usage, condition: r.condition })).join("\n");
    },
    { name: "search", schema: z.object({ product: z.string() }) }
);

// --- NODES ---
const llm = new ChatDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY, model: "deepseek-chat", temperature: 0 });

const extractorModel = llm.withStructuredOutput(EntitySchema);
const researcherModel = llm.bindTools([searchTool]);
const validatorModel = llm.withStructuredOutput(ComplianceSchema);

// Node 1: Extractor
const extractorNode = async (state) => {
    const lastMsg = state.messages[state.messages.length - 1];
    const result = await extractorModel.invoke([new SystemMessage(EXTRACTOR_PROMPT), new HumanMessage(lastMsg.content)]);
    
    return { 
        extractedData: result, 
        messages: [new AIMessage({ content: `Extracted: ${JSON.stringify(result)}`, id: `ext_${Date.now()}` })] 
    };
};

// Node 2: Researcher (The Brain)
const researcherNode = async (state) => {
    const product = state.extractedData?.product;
    if (!product) {
        // No product? We can't search. Pass to validator to handle the error/missing info.
        return { messages: [new AIMessage({ content: "No product identified, cannot perform search.", id: `res_${Date.now()}` })] };
    }

    // 1. CONTEXT INJECTION
    // We give the Researcher a "System Prompt" derived from the Extractor's findings.
    // This tells it WHAT to focus on, but doesn't blind it to the history.
    const missionPrompt = `You are a Regulatory Researcher.
    Your Mission: Verify compliance for the product "${product}".
    
    1. Search for "${product}" in the database.
    2. Analyze the results.
    3. If results are found, STOP and output a summary.
    4. If no results, you may try a broader search or STOP and say "No data found".`;

    // 2. INVOKE WITH HISTORY
    // We pass [SystemPrompt, ...AllPreviousMessages].
    // This allows the model to see:
    // - User Query
    // - Extractor Output
    // - PREVIOUS SEARCH RESULTS (if this is a loop)
    const messages = [new SystemMessage(missionPrompt), ...state.messages];
    
    const result = await researcherModel.invoke(messages);
    return { messages: [result] };
};

// Node 3: Validator
const validatorNode = async (state) => {
    const result = await validatorModel.invoke(state.messages);
    return { finalResult: result };
};

// Router checks the LAST message from Researcher
const router = (state) => {
    const last = state.messages[state.messages.length - 1];
    
    // If Researcher wants to call a tool -> Go to Tools
    if (last?.tool_calls?.length) return "tools";
    
    // If Researcher returns text (analysis done) -> Go to Validator
    return "next";
};

// --- WORKFLOW ---
const AgentState = Annotation.Root({
    messages: Annotation({
        reducer: (curr, update) => {
            const newMsgs = Array.isArray(update) ? update : [update];
            if (!curr) return newMsgs;
            const res = [...curr];
            for (const m of newMsgs) {
                if (!res.some(e => e.id === m.id)) res.push(m);
            }
            return res;
        },
        default: () => []
    }),
    extractedData: Annotation({ reducer: (current, update) => update || current, default: () => null }),
    finalResult: Annotation({ reducer: (x, y) => y, default: () => null })
});

const workflow = new StateGraph(AgentState)
    .addNode("extractor", extractorNode)
    .addNode("researcher", researcherNode)
    .addNode("validator", validatorNode)
    .addNode("researcher_tools", new ToolNode([searchTool])) 

    .addEdge(START, "extractor")
    .addEdge("extractor", "researcher")
    
    // DECISION LOOP
    .addConditionalEdges("researcher", router, { 
        tools: "researcher_tools", 
        next: "validator" 
    })
    
    // FEEDBACK LOOP: Tool Output -> Back to Researcher
    // This gives the Researcher the "Decision" power to read the result and act again.
    .addEdge("researcher_tools", "researcher")
    
    .addEdge("validator", END);

export const app = workflow.compile({ checkpointer });

// --- HELPERS (Unchanged) ---
export const createInquiry = async (query) => {
    const inquiryId = uuidv4();
    try { sqliteDB.prepare('INSERT INTO inquiries (id, query) VALUES (?, ?)').run(inquiryId, query); } catch (e) {}
    await app.updateState({ configurable: { thread_id: inquiryId } }, { messages: [new HumanMessage({ content: query, id: uuidv4() })] });
    return inquiryId;
};
export const getInquiryRecord = (rawId) => {
    if (!rawId) return null;
    return sqliteDB.prepare('SELECT * FROM inquiries WHERE id = ?').get(rawId.replace(/[^a-z0-9-]/gi, ''));
};
export const getGraphDef = () => ({
    nodes: [
        { id: "start", label: "Start" },
        { id: "extractor", label: "Step 1: Extractor" },
        { id: "researcher", label: "Step 2: Researcher (Decision)" },
        { id: "researcher_tools", label: "Search Tool" },
        { id: "validator", label: "Step 3: Validator" },
        { id: "end", label: "End" }
    ],
    edges: [
        { source: "start", target: "extractor" },
        { source: "extractor", target: "researcher" },
        { source: "researcher", target: "researcher_tools" },
        { source: "researcher_tools", target: "researcher" }, // The Loop
        { source: "researcher", target: "validator" },
        { source: "validator", target: "end" }
    ]
});