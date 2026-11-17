// Single Vercel Node.js Function for the existing HTTP API and browser pages.
const { handleRequest } = require('../server');

module.exports = function botStreamHandler(req, res) {
  return handleRequest(req, res);
};
