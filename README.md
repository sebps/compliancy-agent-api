# API
Compliancy Agent API component enabling external clients to submit and track inquiries regarding product compliancy.

## Environment
Define the following variables in a .env file

| Variable | Description | Value | Default Value |
|---|---|---|---|
| `STATE_URL` | Path to the state database | `your sqllite data path` | `../storage/state/data.db` |
| `DATA_URL`  | Path to search engine data | `your search engine data path` | `../storage/data/data.ndjson` |
| `DEEPSEEK_API_KEY` | API key for DeepSeek service | `YOUR_API_KEY` | `""` |

## Installation
Run `npm install`

## Usage
CLI command to spin up the server:
`npm start`

Note: Pay attention to llm consumption

## HTTP
The server API exposes the following routes:
- POST /inquiries : create a new inquiry
- GET /inquiries/:inquiryId : track an existing inquiry (retrieves a SSE connection)
- GET /graph : fetch the agent graph internal structure for granular tracking

### POST /inquiries
Parameters:
- query : the free text query to check a product compliancy providing its name, intended usage  
Example: "I want to use sodium to create a new rinse-off product with a concentration of 5%"

Response:
- status : the status ("created")
- inquiryId : the id of the inquiry

### GET /inquiries/:inquiryId
Parameters:
- inquiryId : existing inquiry

Response (SSE tracking event stream):
- type : the event type ("EXTRACTION", "RESEARCH", "EXTRACTION_ACTION", "RESEARCH_ACTION", "FINAL_RESULT", "ERROR")
- data : the event data (string)

### GET /graph
Response: the agent graph as a JSON file.

#### Example
```json
{
  "nodes": [
    { "id": "start", "label": "Start" },
    { "id": "extractor", "label": "Step 1: Extractor" },
    { "id": "researcher", "label": "Step 2: Researcher (Decision)" },
    { "id": "researcher_tools", "label": "Search Tool" },
    { "id": "validator", "label": "Step 3: Validator" },
    { "id": "end", "label": "End" }
  ],
  "edges": [
    { "source": "start", "target": "extractor" },
    { "source": "extractor", "target": "researcher" },
    { "source": "researcher", "target": "researcher_tools" },
    { "source": "researcher_tools", "target": "researcher" }, // The Loop
    { "source": "researcher", "target": "validator" },
    { "source": "validator", "target": "end" }
  ]
}
```
```