import fs from 'fs';

const configPath = '/app/configs/config.json';
const poolsPath = '/app/configs/provider_pools.json';
const customModelsPath = '/app/configs/custom_models.json';
const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function backup(path) {
  const backupPath = `${path}.bak-codex-routing-${ts}`;
  fs.copyFileSync(path, backupPath);
  return backupPath;
}

function upsertCustomModel(config, entry) {
  config.customModels = Array.isArray(config.customModels) ? config.customModels : [];
  const idx = config.customModels.findIndex(
    model => model && model.id === entry.id && model.provider === entry.provider
  );
  if (idx >= 0) {
    config.customModels[idx] = {...config.customModels[idx], ...entry};
  } else {
    config.customModels.push(entry);
  }
}

const configBackup = backup(configPath);
const poolsBackup = backup(poolsPath);
const customModelsBackup = fs.existsSync(customModelsPath) ? backup(customModelsPath) : null;

const config = readJson(configPath);
const pools = readJson(poolsPath);
const customModelsFile = fs.existsSync(customModelsPath) ? readJson(customModelsPath) : [];

pools['openai-codex-oauth-plus'] = Array.isArray(pools['openai-codex-oauth-plus'])
  ? pools['openai-codex-oauth-plus']
  : [];

if (Array.isArray(pools['openai-custom'])) {
  for (const provider of pools['openai-custom']) {
    if ((provider.customName || '').toLowerCase() === 'opusclaw' || pools['openai-custom'].length === 1) {
      provider.isDisabled = false;
      provider.isHealthy = provider.isHealthy !== false;
      provider.supportedModels = Array.isArray(provider.supportedModels) ? provider.supportedModels : [];
    }
  }
}

const customModels = [
  {
    id: 'gpt-5.5-free',
    name: 'GPT-5.5 Free',
    provider: 'openai-codex-oauth',
    actualProvider: 'openai-codex-oauth',
    actualModel: 'gpt-5.5',
    description: 'Route to the free Codex OAuth pool'
  },
  {
    id: 'gpt-5.5-plus',
    name: 'GPT-5.5 Plus',
    provider: 'openai-codex-oauth',
    actualProvider: 'openaiResponses-custom-plus',
    actualModel: 'gpt-5.5',
    description: 'Route to the OpenAI Responses Plus provider'
  },
  {
    id: 'gpt-5.5-pro',
    name: 'GPT-5.5 Pro',
    provider: 'openai-codex-oauth',
    actualProvider: 'openai-custom',
    actualModel: 'gpt-5.5',
    description: 'Route to the OpenAI Custom provider'
  }
];

for (const entry of customModels) {
  upsertCustomModel(config, entry);
}

const customModelsConfig = {customModels: Array.isArray(customModelsFile) ? customModelsFile : []};
for (const entry of customModels) {
  upsertCustomModel(customModelsConfig, entry);
}

writeJson(configPath, config);
writeJson(poolsPath, pools);
writeJson(customModelsPath, customModelsConfig.customModels);

console.log(JSON.stringify({
  ok: true,
  backups: {configBackup, poolsBackup, customModelsBackup},
  pools: Object.fromEntries(Object.entries(pools).map(([key, value]) => [key, Array.isArray(value) ? value.length : typeof value])),
  customModels: customModels.map(model => ({
    id: model.id,
    provider: model.provider,
    actualProvider: model.actualProvider,
    actualModel: model.actualModel
  }))
}, null, 2));
