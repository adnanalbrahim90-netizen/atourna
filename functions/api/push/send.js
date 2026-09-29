// POST /api/push/send — deliver a phone notification to given devices.
import { handleSend } from "../../../lib/push-api.js";

export const onRequestPost = ({ request, env }) => handleSend(request, env);
