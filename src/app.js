// Entry point of the single executable: start the local service, open the panel, stay running.
import { reportFailure, run } from './launcher.js';

run().catch(reportFailure);
