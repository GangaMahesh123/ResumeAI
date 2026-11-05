'use strict';
// Domain-aware technology libraries.
// These IDENTIFY and CATEGORISE technologies. They are never used to add
// anything to a candidate's resume on their own.

const T = (term, domains, category, aliases = []) => ({ term, domains, category, aliases });

const LIBRARY = [
  // ── .NET / full stack ──────────────────────────────────────────────
  T('C#', ['dotnet'], 'language', ['csharp', 'c sharp']),
  T('.NET', ['dotnet'], 'framework', ['dotnet']),
  T('.NET Framework', ['dotnet'], 'framework'),
  T('.NET Core', ['dotnet'], 'framework'),
  T('.NET 6', ['dotnet'], 'framework', ['.NET 6.0']),
  T('.NET 7', ['dotnet'], 'framework', ['.NET 7.0']),
  T('.NET 8', ['dotnet'], 'framework', ['.NET 8.0']),
  T('.NET 9', ['dotnet'], 'framework', ['.NET 9.0']),
  T('.NET 10', ['dotnet'], 'framework', ['.NET 10.0']),
  T('ASP.NET', ['dotnet'], 'framework'),
  T('ASP.NET MVC', ['dotnet'], 'framework'),
  T('ASP.NET Core', ['dotnet'], 'framework'),
  T('Web API', ['dotnet'], 'framework', ['WebAPI']),
  T('Minimal APIs', ['dotnet'], 'framework', ['Minimal API']),
  T('Entity Framework', ['dotnet'], 'framework', ['EF6']),
  T('EF Core', ['dotnet'], 'framework', ['Entity Framework Core']),
  T('LINQ', ['dotnet'], 'framework'),
  T('ADO.NET', ['dotnet'], 'framework'),
  T('WCF', ['dotnet'], 'framework'),
  T('VB.NET', ['dotnet'], 'language'),
  T('VB6', ['dotnet'], 'language', ['Visual Basic 6']),
  T('COM+', ['dotnet'], 'framework'),
  T('Classic ASP', ['dotnet'], 'framework'),
  T('Blazor', ['dotnet'], 'frontend'),
  T('Razor', ['dotnet'], 'frontend'),
  T('SignalR', ['dotnet'], 'framework'),
  T('Semantic Kernel', ['genai', 'dotnet'], 'genai'),
  T('Angular', ['dotnet'], 'frontend', ['AngularJS']),
  T('React', ['dotnet'], 'frontend', ['React.js', 'ReactJS']),
  T('Vue', ['dotnet'], 'frontend', ['Vue.js', 'VueJS']),
  T('TypeScript', ['dotnet', 'genai'], 'language'),
  T('JavaScript', ['dotnet'], 'language'),
  T('Node.js', ['dotnet'], 'framework', ['NodeJS']),
  T('RxJS', ['dotnet'], 'frontend'),
  T('Redux', ['dotnet'], 'frontend'),
  T('HTML5', ['dotnet'], 'frontend', ['HTML']),
  T('CSS3', ['dotnet'], 'frontend', ['CSS']),
  T('Bootstrap', ['dotnet'], 'frontend'),
  T('SQL Server', ['dotnet'], 'database', ['MS SQL', 'MSSQL']),
  T('T-SQL', ['dotnet'], 'database'),
  T('Azure SQL', ['dotnet'], 'database'),
  T('Oracle', ['dotnet'], 'database'),
  T('PostgreSQL', ['dotnet', 'aiml'], 'database', ['Postgres']),
  T('MySQL', ['dotnet'], 'database'),
  T('MongoDB', ['dotnet'], 'database'),
  T('Cosmos DB', ['dotnet'], 'database', ['CosmosDB']),
  T('Redis', ['dotnet'], 'database'),
  T('Snowflake', ['aiml', 'dotnet'], 'database'),
  T('SSIS', ['dotnet'], 'database'),
  T('SSRS', ['dotnet'], 'database'),
  T('Stored Procedures', ['dotnet'], 'database', ['Stored Procedure']),
  T('Azure', ['dotnet', 'genai', 'aiml'], 'cloud', ['Microsoft Azure']),
  T('AWS', ['dotnet', 'genai', 'aiml'], 'cloud', ['Amazon Web Services']),
  T('GCP', ['dotnet', 'genai', 'aiml'], 'cloud', ['Google Cloud', 'Google Cloud Platform']),
  T('Azure Functions', ['dotnet'], 'cloud'),
  T('Azure App Services', ['dotnet'], 'cloud', ['Azure App Service']),
  T('Azure Kubernetes Service', ['dotnet'], 'cloud', ['AKS']),
  T('Azure API Management', ['dotnet'], 'cloud', ['APIM']),
  T('Azure Service Bus', ['dotnet'], 'cloud', ['Service Bus']),
  T('Azure Event Grid', ['dotnet'], 'cloud', ['Event Grid']),
  T('Azure Event Hubs', ['dotnet'], 'cloud', ['Event Hubs', 'Event Hub']),
  T('Azure Key Vault', ['dotnet'], 'cloud', ['Key Vault']),
  T('Azure Blob Storage', ['dotnet'], 'cloud', ['Blob Storage']),
  T('Azure AD', ['dotnet'], 'security', ['Azure Active Directory', 'Entra ID', 'Microsoft Entra']),
  T('Azure AD B2C', ['dotnet'], 'security'),
  T('Azure Monitor', ['dotnet'], 'cloud'),
  T('Application Insights', ['dotnet'], 'cloud'),
  T('AWS Lambda', ['dotnet', 'genai', 'aiml'], 'cloud', ['Lambda']),
  T('Amazon S3', ['dotnet', 'aiml'], 'cloud', ['S3']),
  T('Amazon RDS', ['dotnet'], 'cloud', ['RDS']),
  T('Amazon EC2', ['dotnet'], 'cloud', ['EC2']),
  T('Amazon EKS', ['dotnet', 'aiml'], 'cloud', ['EKS']),
  T('Amazon ECS', ['dotnet'], 'cloud', ['ECS']),
  T('API Gateway', ['dotnet'], 'cloud'),
  T('DynamoDB', ['dotnet'], 'database'),
  T('REST', ['dotnet', 'genai'], 'architecture', ['RESTful', 'REST API', 'REST APIs']),
  T('GraphQL', ['dotnet'], 'architecture'),
  T('gRPC', ['dotnet'], 'architecture'),
  T('SOAP', ['dotnet'], 'architecture'),
  T('Microservices', ['dotnet', 'genai'], 'architecture', ['Microservice']),
  T('Event-Driven Architecture', ['dotnet'], 'architecture', ['event-driven', 'event driven']),
  T('DDD', ['dotnet'], 'architecture', ['Domain-Driven Design', 'Domain Driven Design']),
  T('CQRS', ['dotnet'], 'architecture'),
  T('Clean Architecture', ['dotnet'], 'architecture', ['Onion Architecture']),
  T('Kafka', ['dotnet', 'aiml'], 'messaging', ['Apache Kafka']),
  T('RabbitMQ', ['dotnet'], 'messaging'),
  T('Docker', ['dotnet', 'genai', 'aiml'], 'devops'),
  T('Kubernetes', ['dotnet', 'genai', 'aiml'], 'devops', ['K8s']),
  T('Helm', ['dotnet'], 'devops'),
  T('Terraform', ['dotnet', 'aiml'], 'devops'),
  T('Bicep', ['dotnet'], 'devops'),
  T('ARM Templates', ['dotnet'], 'devops'),
  T('CI/CD', ['dotnet', 'genai', 'aiml'], 'devops'),
  T('Azure DevOps', ['dotnet'], 'devops'),
  T('GitHub Actions', ['dotnet', 'genai', 'aiml'], 'devops'),
  T('Jenkins', ['dotnet'], 'devops'),
  T('Git', ['dotnet', 'genai', 'aiml'], 'devops'),
  T('OAuth 2.0', ['dotnet'], 'security', ['OAuth2', 'OAuth']),
  T('JWT', ['dotnet'], 'security'),
  T('OpenID Connect', ['dotnet'], 'security', ['OIDC']),
  T('xUnit', ['dotnet'], 'testing'),
  T('NUnit', ['dotnet'], 'testing'),
  T('MSTest', ['dotnet'], 'testing'),
  T('Moq', ['dotnet'], 'testing'),
  T('Selenium', ['dotnet'], 'testing'),
  T('Jest', ['dotnet'], 'testing'),
  T('Cypress', ['dotnet'], 'testing'),
  T('Playwright', ['dotnet'], 'testing'),
  T('Postman', ['dotnet'], 'testing'),
  T('SonarQube', ['dotnet'], 'testing'),
  T('HL7', ['dotnet'], 'domain'),
  T('FHIR', ['dotnet'], 'domain', ['HL7 FHIR']),
  T('EDI', ['dotnet'], 'domain', ['X12', 'EDI X12']),
  T('HIPAA', ['dotnet'], 'domain'),
  T('GitHub Copilot', ['dotnet', 'genai'], 'tooling', ['Copilot']),

  // ── Generative AI / Agentic AI ─────────────────────────────────────
  T('LLM', ['genai'], 'genai', ['LLMs', 'Large Language Models', 'Large Language Model']),
  T('Generative AI', ['genai'], 'genai', ['GenAI', 'Gen AI']),
  T('Agentic AI', ['genai'], 'genai', ['AI agents', 'AI agent', 'agentic']),
  T('RAG', ['genai'], 'genai', ['Retrieval-Augmented Generation', 'Retrieval Augmented Generation']),
  T('Embeddings', ['genai'], 'genai', ['embedding']),
  T('Vector Search', ['genai'], 'genai', ['vector database', 'vector databases', 'vector store']),
  T('Semantic Search', ['genai'], 'genai'),
  T('Hybrid Retrieval', ['genai'], 'genai', ['hybrid search']),
  T('Reranking', ['genai'], 'genai', ['re-ranking', 'reranker']),
  T('Prompt Engineering', ['genai'], 'genai', ['prompt design']),
  T('Context Management', ['genai'], 'genai', ['context engineering']),
  T('Fine-tuning', ['genai', 'aiml'], 'genai', ['fine tuning', 'finetuning', 'LoRA']),
  T('Tool Calling', ['genai'], 'genai', ['function calling', 'tool use']),
  T('Agent Orchestration', ['genai'], 'genai', ['multi-agent', 'agent orchestration']),
  T('MCP', ['genai'], 'genai', ['Model Context Protocol']),
  T('Claude Agent SDK', ['genai'], 'genai'),
  T('LangChain', ['genai'], 'genai'),
  T('LangGraph', ['genai'], 'genai'),
  T('LlamaIndex', ['genai'], 'genai'),
  T('AutoGen', ['genai'], 'genai'),
  T('CrewAI', ['genai'], 'genai'),
  T('OpenAI', ['genai'], 'genai', ['GPT-4', 'GPT-4o', 'ChatGPT']),
  T('Azure OpenAI', ['genai'], 'genai'),
  T('Azure AI Search', ['genai'], 'genai', ['Azure Cognitive Search']),
  T('AWS Bedrock', ['genai'], 'genai', ['Amazon Bedrock', 'Bedrock']),
  T('Vertex AI', ['genai', 'aiml'], 'genai', ['Google Vertex AI']),
  T('Anthropic Claude', ['genai'], 'genai', ['Claude']),
  T('Hugging Face', ['genai', 'aiml'], 'genai', ['HuggingFace']),
  T('Pinecone', ['genai'], 'genai'),
  T('FAISS', ['genai'], 'genai'),
  T('ChromaDB', ['genai'], 'genai', ['Chroma']),
  T('Weaviate', ['genai'], 'genai'),
  T('pgvector', ['genai'], 'genai'),
  T('LLM Evaluation', ['genai'], 'genai', ['LLM evals', 'evals']),
  T('Guardrails', ['genai'], 'genai'),
  T('FastAPI', ['genai', 'aiml'], 'framework'),
  T('NLP', ['genai', 'aiml'], 'aiml', ['Natural Language Processing']),

  // ── AI/ML / data science ───────────────────────────────────────────
  T('Python', ['aiml', 'genai'], 'language'),
  T('SQL', ['aiml', 'dotnet'], 'language'),
  T('Pandas', ['aiml'], 'aiml'),
  T('NumPy', ['aiml'], 'aiml'),
  T('Scikit-learn', ['aiml'], 'aiml', ['sklearn', 'scikit learn']),
  T('TensorFlow', ['aiml'], 'aiml'),
  T('Keras', ['aiml'], 'aiml'),
  T('PyTorch', ['aiml', 'genai'], 'aiml'),
  T('XGBoost', ['aiml'], 'aiml'),
  T('LightGBM', ['aiml'], 'aiml'),
  T('Transformers', ['aiml', 'genai'], 'aiml'),
  T('Machine Learning', ['aiml'], 'aiml', ['ML']),
  T('Deep Learning', ['aiml'], 'aiml'),
  T('Supervised Learning', ['aiml'], 'aiml'),
  T('Unsupervised Learning', ['aiml'], 'aiml'),
  T('Feature Engineering', ['aiml'], 'aiml'),
  T('Model Evaluation', ['aiml'], 'aiml'),
  T('Computer Vision', ['aiml'], 'aiml'),
  T('MLflow', ['aiml'], 'aiml'),
  T('Kubeflow', ['aiml'], 'aiml'),
  T('SageMaker', ['aiml'], 'aiml', ['Amazon SageMaker']),
  T('Azure Machine Learning', ['aiml'], 'aiml', ['Azure ML']),
  T('Databricks', ['aiml'], 'aiml'),
  T('Spark', ['aiml'], 'aiml', ['Apache Spark']),
  T('PySpark', ['aiml'], 'aiml'),
  T('Airflow', ['aiml'], 'aiml', ['Apache Airflow']),
  T('MLOps', ['aiml'], 'aiml'),
  T('Model Deployment', ['aiml'], 'aiml'),
  T('Drift Monitoring', ['aiml'], 'aiml', ['model drift', 'data drift']),
  T('Jupyter', ['aiml'], 'aiml'),
];

// Very short / ambiguous tokens need exact-case matching to avoid false hits.
const CASE_SENSITIVE = new Set(['ML', 'S3', 'RDS', 'EC2', 'ECS', 'EKS', 'AKS', 'MCP', 'RAG', 'EDI', 'DDD', 'Git', 'Lambda', 'Claude', 'Chroma', 'Bedrock', 'evals']);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const _reCache = new Map();
function termRegex(term) {
  const key = term;
  if (_reCache.has(key)) return _reCache.get(key);
  const flags = CASE_SENSITIVE.has(term) ? 'g' : 'gi';
  // Boundary = not a letter/digit (so "C#," and ".NET Core" work).
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(term)}(?=$|[^A-Za-z0-9+#])`, flags);
  _reCache.set(key, re);
  return re;
}

/** Whole-word, symbol-safe term match. */
function hasTerm(text, term) {
  if (!text || !term) return false;
  const re = termRegex(term);
  re.lastIndex = 0;
  return re.test(text);
}

function countTerm(text, term) {
  if (!text || !term) return 0;
  const re = termRegex(term);
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function hasAny(text, terms) { return (terms || []).some(t => hasTerm(text, t)); }

function allNames(entry) { return [entry.term, ...(entry.aliases || [])]; }

/** Library entries mentioned in a text. */
function findLibraryTerms(text) {
  return LIBRARY.filter(e => hasAny(text, allNames(e)));
}

/**
 * Score a text against each domain. Returns { domain, scores }.
 * domain is one of dotnet | genai | aiml | hybrid.
 */
function detectDomain(text) {
  const scores = { dotnet: 0, genai: 0, aiml: 0 };
  for (const e of LIBRARY) {
    const n = Math.min(5, allNames(e).reduce((s, a) => s + countTerm(text, a), 0));
    if (!n) continue;
    // Shared infrastructure terms (Docker, cloud, Git) are weak signals.
    const w = e.domains.length === 1 ? 1 : 0.3;
    for (const d of e.domains) scores[d] += n * w;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  let domain = top[1] === 0 ? 'hybrid' : top[0];
  if (top[1] > 0 && second[1] >= top[1] * 0.6) domain = 'hybrid';
  return { domain, scores, secondary: second[1] > 0 ? second[0] : null };
}

const DOMAIN_LABEL = { dotnet: '.NET / Full Stack', genai: 'Generative / Agentic AI', aiml: 'AI/ML / Data Science', hybrid: 'Hybrid' };

const DOMAIN_FOCUS = {
  dotnet: 'C#/.NET architecture and development; ASP.NET Core APIs and microservices; Angular, React or Blazor; SQL Server and database performance; Azure/AWS integration; authentication and authorization; CI/CD and cloud deployments; enterprise application modernization.',
  genai: 'LLM applications; RAG pipelines; vector databases and embeddings; agentic AI and tool orchestration; prompt engineering; LLM evaluation and guardrails; enterprise AI integrations; cloud GenAI services; production inference and monitoring.',
  aiml: 'Data preprocessing and feature engineering; ML model development and training; deep learning and NLP; model evaluation and optimization; MLOps and deployment; ML pipelines and orchestration; experiment tracking; model monitoring and drift detection; cloud ML infrastructure.',
};

function domainFocus(domain) {
  if (domain === 'hybrid') return Object.values(DOMAIN_FOCUS).join(' | ');
  return DOMAIN_FOCUS[domain] || DOMAIN_FOCUS.dotnet;
}

module.exports = {
  LIBRARY, hasTerm, hasAny, countTerm, findLibraryTerms, detectDomain,
  DOMAIN_LABEL, domainFocus, allNames
};
