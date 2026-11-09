const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

function getCredential(name) {
  if (process.env[name]) return process.env[name];

  const file = join(homedir(), ".config", "pi", "credentials.json");
  let credentials = {};
  try {
    credentials = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Cannot read Pi credentials from ${file}: ${error.message}`);
    }
  }

  if (typeof credentials[name] !== "string" || !credentials[name]) {
    throw new Error(`Set ${name} in the environment or in ${file}.`);
  }
  return credentials[name];
}

module.exports = { getCredential };
