const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits
} = require('discord.js');



const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const APPS_DIR = path.join(ROOT, 'apps');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'apps.json');

for (const dir of [DATA_DIR, APPS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');

const running = new Map();
const logs = new Map();
const pendingUploads = new Map();
const desiredOnline = new Map();

function loadApps() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveApps(apps) {
  fs.writeFileSync(DB_FILE, JSON.stringify(apps, null, 2), 'utf8');
}

function safeName(name) {
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

function appDir(appId) {
  return path.join(APPS_DIR, appId);
}

function isOwnerOrAdmin(interaction) {
  if (config.donos.includes(interaction.user.id)) return true;
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
}

function addLog(appId, text) {
  const arr = logs.get(appId) || [];
  const line = `[${new Date().toLocaleString('pt-BR')}] ${String(text).replace(/\x1b\[[0-9;]*m/g, '')}`;
  arr.push(line);
  while (arr.length > 80) arr.shift();
  logs.set(appId, arr);
}

function getLogText(appId) {
  const arr = logs.get(appId) || ['Nenhum log ainda.'];
  return arr.slice(-18).join('\n').slice(-1800);
}

function parseCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return { cmd: 'node', args: ['index.js'] };
  const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
  return { cmd: parts[0], args: parts.slice(1) };
}

function commandForPlatform(cmd) {
  if (os.platform() === 'win32' && cmd === 'npm') return 'npm.cmd';
  return cmd;
}

function startApp(appId) {
  const apps = loadApps();
  const app = apps.find(a => a.id === appId);
  if (!app) throw new Error('Aplicação não encontrada.');
  if (running.has(appId)) throw new Error('Essa aplicação já está ligada.');
  desiredOnline.set(appId, true);

  const cwd = appDir(appId);
  const pkgFile = path.join(cwd, 'package.json');
  if (!fs.existsSync(cwd)) throw new Error('Pasta da aplicação não existe.');

  const { cmd, args } = parseCommand(app.startCommand || 'node index.js');
  const child = spawn(commandForPlatform(cmd), args, {
    cwd,
    env: { ...process.env },
    shell: true,
    windowsHide: true
  });

  running.set(appId, child);
  app.status = 'online';
  app.pid = child.pid;
  app.lastStartAt = new Date().toISOString();
  saveApps(apps);
  addLog(appId, `Aplicação ligada. PID: ${child.pid}`);

  child.stdout.on('data', d => addLog(appId, d.toString()));
  child.stderr.on('data', d => addLog(appId, `[ERRO] ${d.toString()}`));
  child.on('error', err => addLog(appId, `[FALHA AO INICIAR] ${err.message}`));
  child.on('close', code => {
    running.delete(appId);
    const current = loadApps();
    const target = current.find(a => a.id === appId);
    if (target) {
      target.status = 'offline';
      target.pid = null;
      target.lastStopAt = new Date().toISOString();
      saveApps(current);
    }
    addLog(appId, `Aplicação desligada. Código: ${code}`);

    if (config.manterAplicacoesOnline && desiredOnline.get(appId)) {
      addLog(appId, `Auto-restart ativado. Reiniciando em ${config.tempoReinicioMs || 3000}ms...`);
      setTimeout(() => {
        if (!running.has(appId) && desiredOnline.get(appId)) {
          try { startApp(appId); } catch (err) { addLog(appId, `[AUTO-RESTART ERRO] ${err.message}`); }
        }
      }, config.tempoReinicioMs || 3000);
    }
  });
}

function stopApp(appId) {
  desiredOnline.set(appId, false);
  const proc = running.get(appId);
  if (!proc) {
    const apps = loadApps();
    const app = apps.find(a => a.id === appId);
    if (app) {
      app.status = 'offline';
      app.pid = null;
      saveApps(apps);
    }
    throw new Error('Essa aplicação já está desligada.');
  }
  proc.kill('SIGTERM');
  running.delete(appId);
  addLog(appId, 'Comando de desligar enviado.');
}

async function restartApp(appId) {
  try { stopApp(appId); } catch {}
  await new Promise(r => setTimeout(r, 1200));
  startApp(appId);
}

function installDependencies(appId) {
  return new Promise((resolve) => {
    const cwd = appDir(appId);
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
      addLog(appId, 'package.json não encontrado. Pulando npm install.');
      return resolve();
    }
    addLog(appId, 'Instalando dependências: npm install');
    const child = spawn(commandForPlatform('npm'), ['install', '--omit=dev'], {
      cwd,
      shell: true,
      windowsHide: true
    });
    child.stdout.on('data', d => addLog(appId, d.toString()));
    child.stderr.on('data', d => addLog(appId, `[NPM] ${d.toString()}`));
    child.on('close', code => {
      addLog(appId, `npm install finalizado. Código: ${code}`);
      resolve();
    });
    child.on('error', err => {
      addLog(appId, `Erro no npm install: ${err.message}`);
      resolve();
    });
  });
}

function extractZip(zipPath, targetDir) {
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const dest = path.resolve(targetDir, entry.entryName);
    if (!dest.startsWith(path.resolve(targetDir))) throw new Error('ZIP inválido: tentativa de path traversal bloqueada.');
  }
  zip.extractAllTo(targetDir, true);

  const files = fs.readdirSync(targetDir);
  if (files.length === 1) {
    const only = path.join(targetDir, files[0]);
    if (fs.statSync(only).isDirectory()) {
      for (const file of fs.readdirSync(only)) fs.renameSync(path.join(only, file), path.join(targetDir, file));
      fs.rmSync(only, { recursive: true, force: true });
    }
  }
}


function parseSizeToGB(input) {
  const raw = String(input || '').trim().toLowerCase().replace(',', '.');
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(gb|g|mb|m|tb|t)?/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = (match[2] || 'gb').toLowerCase();
  if (unit === 'mb' || unit === 'm') return value / 1024;
  if (unit === 'tb' || unit === 't') return value * 1024;
  return value;
}

function findZipUrl(text) {
  const match = String(text || '').match(/https?:\/\/\S+/i);
  if (!match) return null;
  return match[0].replace(/[>)\]}.,]+$/g, '');
}

function downloadFile(url, dest, maxBytes, appId) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https://') ? https : http;
    const file = fs.createWriteStream(dest);
    let downloaded = 0;

    const request = proto.get(url, { headers: { 'User-Agent': 'DiscordHostBot/1.0' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.rmSync(dest, { force: true }));
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, maxBytes, appId));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close(() => fs.rmSync(dest, { force: true }));
        return reject(new Error(`Download falhou. HTTP ${res.statusCode}`));
      }

      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength && contentLength > maxBytes) {
        file.close(() => fs.rmSync(dest, { force: true }));
        return reject(new Error('Arquivo maior que o limite configurado.'));
      }

      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          request.destroy(new Error('Arquivo maior que o limite configurado.'));
          return;
        }
        if (appId && downloaded % (1024 * 1024 * 500) < chunk.length) {
          addLog(appId, `Baixando ZIP externo... ${(downloaded / 1024 / 1024 / 1024).toFixed(2)}GB`);
        }
      });

      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    request.setTimeout(0);
    request.on('error', err => {
      file.close(() => fs.rmSync(dest, { force: true }));
      reject(err);
    });
  });
}

async function processZipForApp(app, zipPath, authorId) {
  const apps = loadApps();
  const dbApp = apps.find(a => a.id === app.id);
  if (!dbApp) throw new Error('Aplicação não encontrada.');

  try { stopApp(dbApp.id); } catch {}
  extractZip(zipPath, appDir(dbApp.id));
  dbApp.status = 'instalando';
  dbApp.updatedAt = new Date().toISOString();
  dbApp.lastUploadBy = authorId;
  saveApps(apps);
  addLog(dbApp.id, 'ZIP recebido e extraído com sucesso.');
  await installDependencies(dbApp.id);
  dbApp.status = 'offline';
  saveApps(apps);
  if (config.iniciarAplicacaoAposUpload) {
    try { startApp(dbApp.id); } catch (err) { addLog(dbApp.id, err.message); }
  }
  return dbApp;
}

function mainPanel() {
  const embed = new EmbedBuilder()
    .setTitle('HOSPEDAGEM DE APLICAÇÕES')
    .setDescription('Escolha uma opção abaixo para criar, atualizar, excluir ou gerenciar aplicações hospedadas.')
    .setColor(0x2b2d31);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('host:create').setLabel('Criar aplicação').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('host:update').setLabel('Atualizar Aplicação').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('host:delete').setLabel('Excluir Aplicação').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('host:manage').setLabel('Gerenciar Aplicação').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}

function appsSelect(customId, placeholder) {
  const apps = loadApps();
  if (!apps.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(apps.slice(0, 25).map(app => ({
        label: app.name.slice(0, 100),
        value: app.id,
        description: `Status: ${app.status || 'offline'} | Comando: ${app.startCommand}`.slice(0, 100)
      })))
  );
}

function managePanel(appId) {
  const apps = loadApps();
  const app = apps.find(a => a.id === appId);
  if (!app) return { content: 'Aplicação não encontrada.', ephemeral: true };

  const embed = new EmbedBuilder()
    .setTitle(`GERENCIAR: ${app.name}`)
    .setDescription(`Status: \`${running.has(appId) ? 'online' : 'offline'}\`\nPID: \`${app.pid || 'nenhum'}\`\nComando: \`${app.startCommand}\`\n\nTerminal da aplicação:\n\`\`\`\n${getLogText(appId)}\n\`\`\``)
    .setColor(running.has(appId) ? 0x57f287 : 0xed4245);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app:start:${appId}`).setLabel('Ligar Aplicação').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app:restart:${appId}`).setLabel('Reiniciar Aplicação').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`app:stop:${appId}`).setLabel('Desligar Aplicação').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`app:refresh:${appId}`).setLabel('Atualizar Terminal').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app:config:${appId}`).setLabel('Configurar Aplicação').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`app:update:${appId}`).setLabel('Atualizar Aplicação').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`app:delete:${appId}`).setLabel('Excluir Aplicação').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('hospedagem')
      .setDescription('Abre o painel de hospedagem de aplicações.')
      .toJSON()
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationGuildCommands(config.clientIdDoBot, config.idDoServidor), { body: commands });
  console.log('Comando /hospedagem registrado.');
}

client.once('ready', async () => {
  console.log(`Online como ${client.user.tag}`);
  await registerCommands().catch(console.error);
});

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    if (!isOwnerOrAdmin(interaction)) return interaction.reply({ content: 'Você não tem permissão para usar este painel.', ephemeral: true });

    if (interaction.isChatInputCommand() && interaction.commandName === 'hospedagem') {
      return interaction.reply(mainPanel());
    }

    if (interaction.isButton() && interaction.customId === 'host:create') {
      const apps = loadApps();
      if (apps.length >= config.quantidadeMaximaAplicacoes) return interaction.reply({ content: `Limite máximo de ${config.quantidadeMaximaAplicacoes} aplicações atingido.`, ephemeral: true });
      const modal = new ModalBuilder().setCustomId('modal:create').setTitle('Criar aplicação');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nome').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cmd').setLabel('Comando inicial').setPlaceholder('Ex: node index.js ou npm start').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(120)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('size').setLabel('Tamanho do arquivo').setPlaceholder('Ex: 50MB, 2GB, 250GB, 1TB').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20))
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal:create') {
      const name = interaction.fields.getTextInputValue('name');
      const startCommand = interaction.fields.getTextInputValue('cmd');
      const declaredSize = interaction.fields.getTextInputValue('size');
      const declaredGB = parseSizeToGB(declaredSize);
      const id = `${Date.now()}-${safeName(name)}`;
      const apps = loadApps();
      apps.push({ id, name, startCommand, declaredSize, declaredGB, status: 'aguardando_zip', pid: null, createdBy: interaction.user.id, createdAt: new Date().toISOString() });
      saveApps(apps);
      pendingUploads.set(interaction.user.id, { mode: 'create', appId: id, declaredGB });

      const discordLimitInfo = declaredGB > 0.5
        ? '\n\nComo esse tamanho é grande, mande um **link direto HTTPS/HTTP para o .zip**. Também aceito arquivo anexado se o Discord permitir.'
        : '\n\nPode mandar o **arquivo .zip anexado** ou um **link direto do .zip**.';

      return interaction.reply({ content: `Aplicação **${name}** criada. Tamanho informado: **${declaredSize}**.${discordLimitInfo}\n\nExemplo de link aceito: \`https://seudominio.com/meubot.zip\``, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId === 'host:update') {
      const row = appsSelect('select:update', 'Selecione a aplicação para atualizar');
      if (!row) return interaction.reply({ content: 'Nenhuma aplicação cadastrada.', ephemeral: true });
      return interaction.reply({ content: 'Escolha a aplicação que receberá o novo ZIP:', components: [row], ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select:update') {
      const appId = interaction.values[0];
      pendingUploads.set(interaction.user.id, { mode: 'update', appId });
      return interaction.update({ content: 'Mande o arquivo **.zip** da nova aplicação neste chat.', components: [] });
    }

    if (interaction.isButton() && interaction.customId === 'host:delete') {
      const row = appsSelect('select:delete', 'Selecione a aplicação para excluir');
      if (!row) return interaction.reply({ content: 'Nenhuma aplicação cadastrada.', ephemeral: true });
      return interaction.reply({ content: 'Escolha a aplicação que será excluída:', components: [row], ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select:delete') {
      const appId = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`modal:delete:${appId}`).setTitle('Confirmar exclusão');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('confirm').setLabel('Tem certeza disso? Escreva sim').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal:delete:')) {
      const appId = interaction.customId.split(':')[2];
      const confirm = interaction.fields.getTextInputValue('confirm').toLowerCase().trim();
      if (confirm !== 'sim') return interaction.reply({ content: 'Exclusão cancelada.', ephemeral: true });
      try { stopApp(appId); } catch {}
      const apps = loadApps().filter(a => a.id !== appId);
      saveApps(apps);
      fs.rmSync(appDir(appId), { recursive: true, force: true });
      logs.delete(appId);
      return interaction.reply({ content: 'Aplicação excluída com sucesso.', ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId === 'host:manage') {
      const row = appsSelect('select:manage', 'Selecione a aplicação para gerenciar');
      if (!row) return interaction.reply({ content: 'Nenhuma aplicação cadastrada.', ephemeral: true });
      return interaction.reply({ content: 'Escolha a aplicação:', components: [row], ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select:manage') {
      return interaction.update(managePanel(interaction.values[0]));
    }

    if (interaction.isButton() && interaction.customId.startsWith('app:')) {
      const [, action, appId] = interaction.customId.split(':');

      if (action === 'config') {
        const apps = loadApps();
        const app = apps.find(a => a.id === appId);
        if (!app) return interaction.reply({ content: 'Aplicação não encontrada.', ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`modal:config:${appId}`).setTitle('Configurar Aplicação');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Novo nome da aplicação')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(40)
              .setValue(app.name.slice(0, 40))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('cmd')
              .setLabel('Novo comando inicial')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(180)
              .setValue(String(app.startCommand || 'node index.js').slice(0, 180))
          )
        );
        return interaction.showModal(modal);
      }

      if (action === 'delete') {
        const modal = new ModalBuilder().setCustomId(`modal:delete:${appId}`).setTitle('Excluir Aplicação');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('confirm').setLabel('Tem certeza? Responda com sim').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        ));
        return interaction.showModal(modal);
      }

      if (action === 'update') {
        pendingUploads.set(interaction.user.id, { mode: 'update', appId });
        return interaction.reply({ content: 'Mande o novo **.zip**.', ephemeral: true });
      }

      await interaction.deferUpdate();
      try {
        if (action === 'start') startApp(appId);
        if (action === 'stop') stopApp(appId);
        if (action === 'restart') await restartApp(appId);
      } catch (err) {
        addLog(appId, err.message);
      }
      return interaction.editReply(managePanel(appId));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal:config:')) {
      const appId = interaction.customId.split(':')[2];
      const name = interaction.fields.getTextInputValue('name');
      const startCommand = interaction.fields.getTextInputValue('cmd');
      const apps = loadApps();
      const app = apps.find(a => a.id === appId);
      if (!app) return interaction.reply({ content: 'Aplicação não encontrada.', ephemeral: true });
      app.name = name;
      app.startCommand = startCommand;
      app.updatedAt = new Date().toISOString();
      saveApps(apps);
      addLog(appId, `Configuração atualizada. Nome: ${name} | Comando: ${startCommand}`);
      return interaction.reply({ content: 'Aplicação configurada com sucesso.', ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) return interaction.followUp({ content: `Erro: ${err.message}`, ephemeral: true });
    return interaction.reply({ content: `Erro: ${err.message}`, ephemeral: true });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!config.donos.includes(message.author.id) && !message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  const pending = pendingUploads.get(message.author.id);
  if (!pending) return;

  const apps = loadApps();
  const app = apps.find(a => a.id === pending.appId);
  if (!app) {
    pendingUploads.delete(message.author.id);
    return message.reply('Aplicação não encontrada.');
  }

  const maxZipBytes = Number(config.qntdMaximaGB || 250) * 1024 * 1024 * 1024;
  const zipPath = path.join(UPLOADS_DIR, `${app.id}.zip`);
  const attachment = message.attachments.first();
  const externalUrl = findZipUrl(message.content);

  if (!attachment && !externalUrl) {
    return message.reply('Mande um arquivo `.zip` anexado ou um link direto `https://.../arquivo.zip`.');
  }

  try {
    if (attachment) {
      if (!attachment.name.toLowerCase().endsWith('.zip')) return message.reply('Envie um arquivo `.zip` válido.');
      if (attachment.size > maxZipBytes) return message.reply(`O ZIP passou de ${config.qntdMaximaGB || 250}GB.`);
      addLog(app.id, `Recebendo ZIP via Discord: ${attachment.name}`);
      await downloadFile(attachment.url, zipPath, maxZipBytes, app.id);
    } else {
      if (!config.permitirLinksZipExternos) return message.reply('Links externos estão desativados no `config.json`.');
      if (!externalUrl.toLowerCase().includes('.zip')) {
        return message.reply('O link precisa ser direto para um arquivo `.zip`. Exemplo: `https://site.com/bot.zip`');
      }
      addLog(app.id, `Recebendo ZIP por link externo: ${externalUrl}`);
      await message.reply('Link recebido. Iniciando download externo do `.zip`. Para arquivos gigantes, acompanhe pelo terminal da aplicação.');
      await downloadFile(externalUrl, zipPath, maxZipBytes, app.id);
    }

    const dbApp = await processZipForApp(app, zipPath, message.author.id);
    pendingUploads.delete(message.author.id);
    await message.reply(`Aplicação **${dbApp.name}** enviada e hospedada com sucesso.`);
  } catch (err) {
    addLog(app.id, `Erro no recebimento do ZIP: ${err.message}`);
    await message.reply(`Erro ao hospedar: ${err.message}`);
  }
});

process.on('unhandledRejection', err => console.error('UnhandledRejection:', err));
process.on('uncaughtException', err => console.error('UncaughtException:', err));

client.login(process.env.TOKEN);
