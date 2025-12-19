import express from 'express';
import cors from 'cors';
import { app as agent, getGraphDef, createInquiry, getInquiryRecord } from './agent.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. POST ---
app.post('/inquiries', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query is required" });

        const inquiryId = await createInquiry(query);
        res.status(201).json({ inquiryId, status: "created" });
    } catch (error) {
        console.error("Creation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- 2. GET GRAPH ---
app.get('/graph', (req, res) => res.json(getGraphDef()));

// --- 3. GET STREAM ---
app.get('/inquiries/:inquiryId', async (req, res) => {
    // 1. Sanitize ID
    const rawId = req.params.inquiryId || "";
    const inquiryId = rawId.replace(/[^a-z0-9-]/gi, '');

    // 2. Validate Business Record
    const record = getInquiryRecord(inquiryId);
    if (!record) {
        return res.status(404).json({ error: "Inquiry not found" });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
    });
    res.write(`: ${" ".repeat(2048)}\n\n`);

    const config = { configurable: { thread_id: inquiryId } };
    
    // 3. Setup Deduplication
    const sentIds = new Set();

    const processMessage = (msg) => {
        if (!msg) return;
        
        // Check ID to prevent double-sending messages
        if (msg.id) {
            if (sentIds.has(msg.id)) return;
            sentIds.add(msg.id);
        }

        if (msg.getType() === 'human' || msg.role === 'user') {
            sendEvent(res, "USER_QUERY", msg.content);
        } else if (msg.tool_calls?.length) {
            const tool = msg.tool_calls[0];
            if (tool.name === 'extractor') sendEvent(res, "EXTRACTION", "Identified entities...");
            else if (tool.name === 'search') sendEvent(res, "RESEARCH", `Searching: ${tool.args.product || '...'}`);
        } else if (msg.getType() === 'tool') {
            const type = msg.name === 'extractor' ? "EXTRACTION_ACTION" : "RESEARCH_ACTION";
            sendEvent(res, type, msg.content);
        }
    };

    try {
        // 4. Fetch History
        const currentState = await agent.getState(config);
        const existingMessages = currentState.values.messages || [];

        // 5. Replay History (Populates sentIds)
        for (const msg of existingMessages) processMessage(msg);

        if (currentState.values.finalResult) {
            sendEvent(res, "FINAL_RESULT", currentState.values.finalResult);
            sendEvent(res, "DONE", "Finished");
            res.end();
            return;
        }

        // 6. Kickstart Logic
        let inputs = null;
        if (!currentState.next || currentState.next.length === 0) {
            inputs = { messages: existingMessages };
        }

        // 7. Run Stream
        const stream = await agent.stream(inputs, { ...config, streamMode: "updates" });

        for await (const chunk of stream) {
            const nodeName = Object.keys(chunk)[0];
            const content = chunk[nodeName];

            if (content.error) {
                sendEvent(res, "ERROR", content.error);
                res.end();
                return;
            }
            if (content.messages) {
                for (const msg of content.messages) processMessage(msg);
            }
            if (content.finalResult) {
                sendEvent(res, "FINAL_RESULT", content.finalResult);
            }
        }
        
        sendEvent(res, "DONE", "Stream finished");
        res.end();

    } catch (error) {
        console.error("Stream Error:", error);
        sendEvent(res, "ERROR", error.message);
        res.end();
    }
});

function sendEvent(res, type, data) {
    const payload = type === 'FINAL_RESULT' ? { type, data } : { type, content: data };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (res.flush) res.flush();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));