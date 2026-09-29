// GET /api/push/key — public notification key for this app.
import { handleKey } from "../../../lib/push-api.js";

export const onRequestGet = ({ env }) => handleKey(env);
