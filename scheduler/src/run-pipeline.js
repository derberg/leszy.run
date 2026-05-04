import { runPipeline } from './pipeline.js';

const result = await runPipeline();
process.exit(result.ok ? 0 : 1);
