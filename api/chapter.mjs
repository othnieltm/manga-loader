import backend from '../backend/server.js';

export default function handler(req, res) {
  return backend.handleRequest(req, res);
}
