require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const FIVEM_IP = process.env.FIVEM_IP;
const FIVEM_PORT = process.env.FIVEM_PORT;
const WHITELIST_CHANNEL_ID = process.env.WHITELIST_CHANNEL_ID;
const WHITELIST_ROLE_ID = process.env.WHITELIST_ROLE_ID;
const STATUS_CHANNEL_ID = '1524442383645937856';
const STATUS_UPDATE_INTERVAL_MS = 60 * 1000; // toutes les 60 secondes

let statusMessageId = null;

// ----------------------------------------------------
// Config du système de tickets
// ----------------------------------------------------
const TICKET_PANEL_CHANNEL_ID = '1523850741608091811';
const TICKET_COMMANDE_CATEGORY_ID = '1523850696401883263';
const TICKET_DISCORD_CATEGORY_ID = '1523850695554498590';

const ROLE_COMMANDE_ID = '1523850630500712488'; // seul rôle avec accès aux tickets commande
const ROLE_DISCORD_1_ID = '1523850639321464883'; // rôles avec accès aux tickets discord + ping auto
const ROLE_DISCORD_2_ID = '1523850631398293544';

// Rôles autorisés à verrouiller / rouvrir un ticket
const LOCK_ALLOWED_ROLES = [
  '1523850623085314259',
  '1523850631398293544',
  '1523850639321464883',
  '1523850627950841947',
];

function canLockTicket(member) {
  return member.roles.cache.some((role) => LOCK_ALLOWED_ROLES.includes(role.id));
}

// --- Transcript des tickets ---
const TRANSCRIPT_CHANNEL_ID = '1523850751116574882';

// --- Suivi des commandes (numéro -> statut) ---
const commandeOrders = new Map();
const ticketOrders = new Map(); // channelId -> même objet order (référence partagée avec commandeOrders)

// --- Stockage persistant (survit aux redémarrages via un salon Discord dédié) ---
const STORAGE_CHANNEL_ID = '1525003502978601003';
const botStats = {
  ticketsOpened: 0,
  ticketsClosed: 0,
  responseTimes: [], // en millisecondes
  deliveries: [], // { numero, timestamp }
};
const ticketCreatedAt = new Map(); // channelId -> timestamp de création
const ticketResponded = new Set(); // channelId déjà répondu par un staff

async function savePersistedData() {
  try {
    const data = {
      orders: Array.from(commandeOrders.entries()),
      stats: botStats,
      nextCommandeChannelCounter,
    };
    const buffer = Buffer.from(JSON.stringify(data), 'utf-8');
    const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);

    await storageChannel.send({ files: [{ attachment: buffer, name: 'data.json' }] });

    // Nettoyage : ne garde que le dernier message pour éviter d'accumuler
    const messages = await storageChannel.messages.fetch({ limit: 10 });
    const sorted = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const toDelete = sorted.slice(1); // tout sauf le plus récent
    for (const msg of toDelete) {
      await msg.delete().catch(() => {});
    }
  } catch (err) {
    console.error('❌ Erreur lors de la sauvegarde des données :', err);
  }
}

async function loadPersistedData() {
  try {
    const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    const messages = await storageChannel.messages.fetch({ limit: 1 });
    const lastMessage = messages.first();

    if (!lastMessage || lastMessage.attachments.size === 0) {
      console.log('[Stockage] Aucune donnée précédente trouvée, démarrage à vide.');
      return;
    }

    const attachment = lastMessage.attachments.first();
    const response = await fetch(attachment.url);
    const data = await response.json();

    if (data.orders) {
      for (const [numero, order] of data.orders) {
        commandeOrders.set(numero, order);
        if (order.ticketChannelId) {
          ticketOrders.set(order.ticketChannelId, order);
        }
      }
    }

    if (data.stats) {
      Object.assign(botStats, data.stats);
    }

    if (typeof data.nextCommandeChannelCounter === 'number') {
      nextCommandeChannelCounter = data.nextCommandeChannelCounter;
    }

    console.log(`[Stockage] Données chargées : ${commandeOrders.size} commande(s), ${botStats.ticketsOpened} ticket(s) ouverts au total, prochain numéro CMD : ${nextCommandeChannelCounter}.`);
  } catch (err) {
    console.error('❌ Erreur lors du chargement des données :', err);
  }
}
const ORDER_STATUSES = {
  en_attente: '⏳ En attente',
  en_cours: '🔧 En cours de traitement',
  livree: '✅ Livrée',
};

// --- Alerte serveur hors ligne ---
const OFFLINE_ALERT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const STAFF_ALERT_ROLE_ID = '1523850627950841947';
let offlineSince = null;
let alertSent = false;

// ----------------------------------------------------
// Fonction utilitaire : récupère les infos du serveur FiveM
// ----------------------------------------------------
async function getFivemStatus() {
  const base = `http://${FIVEM_IP}:${FIVEM_PORT}`;

  const [dynamicRes, playersRes] = await Promise.all([
    fetch(`${base}/dynamic.json`),
    fetch(`${base}/players.json`),
  ]);

  if (!dynamicRes.ok || !playersRes.ok) {
    throw new Error('Impossible de contacter le serveur FiveM');
  }

  const dynamic = await dynamicRes.json();
  const players = await playersRes.json();

  return { dynamic, players };
}

// ----------------------------------------------------
// Construit l'embed de statut (en ligne / hors ligne)
// ----------------------------------------------------
function buildStatusEmbed(data) {
  if (!data) {
    return new EmbedBuilder()
      .setTitle('🔴 Serveur Fermé')
      .setColor(0xe74c3c)
      .setTimestamp();
  }

  const { dynamic } = data;

  return new EmbedBuilder()
    .setTitle(`🟢 ${dynamic.hostname || 'Serveur FiveM'}`)
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Statut', value: 'En ligne ✅', inline: true },
      { name: 'Joueurs', value: `${dynamic.clients} / ${dynamic.sv_maxclients}`, inline: true },
      { name: 'Connexion', value: `\`\`\`connect ${FIVEM_IP}:${FIVEM_PORT}\`\`\`` },
    )
    .setFooter({ text: 'Dernière mise à jour' })
    .setTimestamp();
}

// ----------------------------------------------------
// Met à jour (ou crée) le message de statut persistant
// ----------------------------------------------------
async function updateStatusMessage() {
  try {
    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);

    let data = null;
    try {
      data = await getFivemStatus();
    } catch (err) {
      data = null; // serveur hors ligne ou injoignable
    }

    // --- Gestion de l'alerte serveur hors ligne ---
    if (!data) {
      if (!offlineSince) {
        offlineSince = Date.now();
      } else if (!alertSent && Date.now() - offlineSince >= OFFLINE_ALERT_THRESHOLD_MS) {
        alertSent = true;
        await channel.send(
          `🚨 <@&${STAFF_ALERT_ROLE_ID}> Le serveur FiveM semble hors ligne depuis plus de 5 minutes !`
        ).catch(() => {});
      }
    } else {
      if (alertSent) {
        await channel.send(`✅ Le serveur FiveM est de nouveau en ligne.`).catch(() => {});
      }
      offlineSince = null;
      alertSent = false;
    }

    const embed = buildStatusEmbed(data);

    if (statusMessageId) {
      try {
        const existingMessage = await channel.messages.fetch(statusMessageId);
        await existingMessage.edit({ embeds: [embed] });
        return;
      } catch (err) {
        // Le message n'existe plus (supprimé) : on va en recréer un
        statusMessageId = null;
      }
    }

    const sentMessage = await channel.send({ embeds: [embed] });
    statusMessageId = sentMessage.id;
  } catch (err) {
    console.error('❌ Erreur lors de la mise à jour du statut auto :', err);
  }
}

// ----------------------------------------------------
// Quand le bot est prêt
// ----------------------------------------------------
client.once('ready', () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);

  loadPersistedData();

  updateStatusMessage();
  setInterval(updateStatusMessage, STATUS_UPDATE_INTERVAL_MS);
});

// ----------------------------------------------------
// Système de tickets : fonctions utilitaires
// ----------------------------------------------------

// Cherche si l'utilisateur a déjà un ticket ouvert d'un type donné
async function findExistingTicket(guild, userId, type) {
  const channels = await guild.channels.fetch();
  return channels.find(
    (ch) => ch && ch.topic === `ticket:${type}:${userId}`
  );
}

function sanitizeName(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 20);
}

// Compteur permanent pour les numéros de ticket CMD-XXX (persiste même après fermeture des tickets)
let nextCommandeChannelCounter = 1;

function getNextCommandeNumber() {
  const number = nextCommandeChannelCounter;
  nextCommandeChannelCounter += 1;
  return number;
}

function buildCommandeChannelName(number, emoji = '🔴') {
  return `⌈${emoji}⌋・cmd-${String(number).padStart(3, '0')}`;
}

function statusEmoji(status) {
  if (status === 'en_attente') return '🔴';
  if (status === 'en_cours') return '🟠';
  if (status === 'livree') return '🟢';
  return '🔴';
}

// Applique un changement de statut à une commande, met à jour le salon et renvoie le message à afficher.
// Peut être appelée depuis la commande Discord /statut-commande OU depuis l'API externe (script FiveM/txAdmin).
async function applyOrderStatusUpdate({ channel, openerId, nouveauStatut }) {
  // Récupère la commande existante liée à ce salon, ou en crée une nouvelle avec un numéro aléatoire
  let order = ticketOrders.get(channel.id);
  if (!order) {
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    order = { numero: `CMD-${randomNumber}`, status: 'en_attente', ticketChannelId: channel.id, userId: openerId };
    ticketOrders.set(channel.id, order);
    commandeOrders.set(order.numero, order);
  }

  order.status = nouveauStatut;

  // Met à jour la couleur du rond dans le nom du salon
  const match = channel.name.match(/cmd-(\d+)/i);
  if (match) {
    const number = parseInt(match[1], 10);
    const emoji = statusEmoji(nouveauStatut);
    await channel.setName(buildCommandeChannelName(number, emoji)).catch(() => {});
  }

  let messageContent = null;
  let ephemeral = false;

  if (nouveauStatut === 'en_cours') {
    messageContent = `Bonjour, <@${openerId}>

Votre numéro de commande est : **${order.numero}**.

Votre véhicule est actuellement **en cours de traitement** par notre équipe sur le serveur de développement **S.T.O.R.M. Studio**.

⚠️ **Attention : ce numéro est strictement personnel et confidentiel. Ne le divulguez jamais et ne le partagez avec personne.**
Un membre du staff de **S.T.O.R.M. Studio** ne vous demandera **jamais** votre numéro de commande.

Pour ouvrir le menu, appuyez simplement sur la touche **F5**.

Vous serez informé dès que le traitement de votre véhicule sera terminé.

Merci de votre patience.

**Cordialement,**
<:BlueStaffBadge:1523902333161967686> **| L'équipe S.T.O.R.M. Studio**`;
  } else if (nouveauStatut === 'livree') {
    messageContent = `Bonjour, <@${openerId}>

Votre numéro de commande est : **${order.numero}**.

✅ Votre véhicule a été livré avec succès sur le serveur de développement **S.T.O.R.M. Studio**.

⚠️ **Attention : ce numéro est strictement personnel et confidentiel. Ne le divulguez jamais et ne le partagez avec personne.**
Un membre du staff de **S.T.O.R.M. Studio** ne vous demandera **jamais** votre numéro de commande.

Pour ouvrir le menu en jeu, appuyez simplement sur la touche **F5**.

Si vous rencontrez un problème lors des tests, n'hésitez pas à nous contacter.

**Cordialement,**
<:BlueStaffBadge:1523902333161967686> **| L'équipe S.T.O.R.M. Studio**`;

    botStats.deliveries.push({ numero: order.numero, timestamp: Date.now() });
  } else {
    const statusLabel = ORDER_STATUSES[nouveauStatut] || nouveauStatut;
    messageContent = `✅ Statut mis à jour : ${statusLabel}`;
    ephemeral = true;
  }

  await savePersistedData();

  return { messageContent, ephemeral, order };
}

function buildSupportChannelName(username) {
  return `⌈🔴⌋・support-${sanitizeName(username)}`;
}

// Génère un transcript texte du salon et l'envoie dans le salon de logs
async function sendTicketTranscript(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const sorted = Array.from(messages.values()).reverse();

    const lines = sorted.map((msg) => {
      const time = msg.createdAt.toLocaleString('fr-FR');
      const author = msg.author.tag;
      const content = msg.content || '[embed / composant]';
      return `[${time}] ${author} : ${content}`;
    });

    const transcriptText = lines.join('\n') || 'Aucun message dans ce ticket.';
    const buffer = Buffer.from(transcriptText, 'utf-8');

    const logChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
    const sentMessage = await logChannel.send({
      content: `📄 Transcript du ticket **${channel.name}**`,
      files: [{ attachment: buffer, name: `${channel.name}.txt` }],
    });

    // Lie le transcript à la commande correspondante (pour l'API du site web)
    const order = ticketOrders.get(channel.id);
    if (order) {
      const attachment = sentMessage.attachments.first();
      order.transcriptUrl = attachment ? attachment.url : null;
      order.closedAt = Date.now();
      await savePersistedData();
    }
  } catch (err) {
    console.error('❌ Erreur lors de la génération du transcript :', err);
  }
}

async function createCommandeTicket(interaction, typeCommande, details) {
  const guild = interaction.guild;
  const existing = await findExistingTicket(guild, interaction.user.id, 'commande');

  if (existing) {
    await interaction.editReply(`⚠️ Tu as déjà un ticket commande ouvert : <#${existing.id}>`);
    return;
  }

  const nextNumber = getNextCommandeNumber();
  const channelName = buildCommandeChannelName(nextNumber);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: TICKET_COMMANDE_CATEGORY_ID,
    topic: `ticket:commande:${interaction.user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: ROLE_COMMANDE_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ],
  });

  ticketCreatedAt.set(channel.id, Date.now());
  botStats.ticketsOpened += 1;
  await savePersistedData();

  const embed = new EmbedBuilder()
    .setTitle('🛒 Nouveau ticket commande')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Client', value: `<@${interaction.user.id}>` },
      { name: 'Type de commande', value: typeCommande },
      { name: 'Détails de la demande', value: details },
    )
    .setTimestamp();

  const lockRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_lock')
      .setLabel('Verrouiller')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
    new ButtonBuilder()
      .setCustomId('ticket_delete')
      .setLabel('Fermer le ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🗑️'),
  );

  await channel.send({
    content: `<@${interaction.user.id}> <@&${ROLE_COMMANDE_ID}>`,
    embeds: [embed],
    components: [lockRow],
  });

  // Génère le numéro de commande dès la création du ticket et envoie le message "en attente"
  const randomNumber = Math.floor(1000 + Math.random() * 9000);
  const order = {
    numero: `CMD-${randomNumber}`,
    status: 'en_attente',
    ticketChannelId: channel.id,
    userId: interaction.user.id,
  };
  ticketOrders.set(channel.id, order);
  commandeOrders.set(order.numero, order);
  await savePersistedData();

  const enAttenteMessage = `Bonjour, <@${interaction.user.id}>

Votre numéro de commande est : **${order.numero}**.

⏳ Votre commande est actuellement en attente. Notre équipe la prendra en charge dans les plus brefs délais.

⚠️ **Attention : ce numéro est strictement personnel et confidentiel. Ne le divulguez jamais et ne le partagez avec personne.**
Un membre du staff de **S.T.O.R.M. Studio** ne vous demandera **jamais** votre numéro de commande.

Vous serez informé dès que le traitement de votre commande débutera.

Merci pour votre patience.

**Cordialement,**
<:BlueStaffBadge:1523902333161967686> **| L'équipe S.T.O.R.M. Studio**`;

  await channel.send({ content: enAttenteMessage });

  await interaction.editReply(`✅ Ton ticket a été créé : <#${channel.id}>`);
}

async function createDiscordTicket(interaction) {
  const guild = interaction.guild;
  const existing = await findExistingTicket(guild, interaction.user.id, 'discord');

  if (existing) {
    await interaction.editReply(`⚠️ Tu as déjà un ticket discord ouvert : <#${existing.id}>`);
    return;
  }

  const channel = await guild.channels.create({
    name: buildSupportChannelName(interaction.user.username),
    type: ChannelType.GuildText,
    parent: TICKET_DISCORD_CATEGORY_ID,
    topic: `ticket:discord:${interaction.user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: ROLE_DISCORD_1_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: ROLE_DISCORD_2_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ],
  });

  ticketCreatedAt.set(channel.id, Date.now());
  botStats.ticketsOpened += 1;
  await savePersistedData();

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Nouveau ticket support Discord')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Membre', value: `<@${interaction.user.id}>` },
      { name: 'Info', value: 'Merci de décrire ta demande avec un maximum de détails.' },
    )
    .setTimestamp();

  const lockRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_lock')
      .setLabel('Verrouiller')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
    new ButtonBuilder()
      .setCustomId('ticket_delete')
      .setLabel('Fermer le ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🗑️'),
  );

  await channel.send({
    content: `<@${interaction.user.id}> <@&${ROLE_DISCORD_1_ID}> <@&${ROLE_DISCORD_2_ID}>`,
    embeds: [embed],
    components: [lockRow],
  });

  await interaction.editReply(`✅ Ton ticket a été créé : <#${channel.id}>`);
}

function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('ℹ️ Informations du ticket')
    .setColor(0x5865f2)
    .setDescription(
      "Bienvenue dans le centre de support ! Ce ticket vous permet de contacter notre équipe afin d'obtenir de l'aide ou de faire une demande."
    )
    .addFields(
      {
        name: '🛠️ Support Discord',
        value:
          "Ce type de ticket est destiné à toutes les demandes liées au serveur Discord (rôle, accès, fonctionnalité, bug, question). Merci de décrire votre problème avec un maximum de détails.",
      },
      {
        name: '🛒 Support Commande',
        value:
          "Ce type de ticket est destiné aux demandes de commande. Indiquez les informations nécessaires concernant ce que vous souhaitez commander, ainsi que toute précision utile.",
      },
    )
    .setFooter({ text: 'Merci de votre confiance et bienvenue dans notre support !' });
}

// ----------------------------------------------------
// Suivi du temps de réponse : première réponse d'un staff dans un ticket
// ----------------------------------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.channel.topic || !message.channel.topic.startsWith('ticket:')) return;
    if (ticketResponded.has(message.channel.id)) return;
    if (!ticketCreatedAt.has(message.channel.id)) return;

    const member = message.member;
    if (!member || !canLockTicket(member)) return;

    const createdAt = ticketCreatedAt.get(message.channel.id);
    const responseTime = Date.now() - createdAt;
    botStats.responseTimes.push(responseTime);
    ticketResponded.add(message.channel.id);

    await savePersistedData();
  } catch (err) {
    console.error('❌ Erreur lors du suivi du temps de réponse :', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  console.log(`[DEBUG] Interaction reçue : type=${interaction.type}, commandName=${interaction.commandName || 'n/a'}, customId=${interaction.customId || 'n/a'}`);
  try {
    // --- Commande /ticket-panel : poste le panneau de tickets ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket-panel') {
      const panelChannel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_open_discord')
          .setLabel('Support Discord')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('ticket_open_commande')
          .setLabel('Support commandes')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Secondary),
      );

      await panelChannel.send({ embeds: [buildTicketPanelEmbed()], components: [row] });
      await interaction.reply({ content: '✅ Panneau de tickets envoyé.', ephemeral: true });
    }

    // --- Commande /transferer-ticket : bascule le ticket actuel entre Support Discord et Support Commande ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'transferer-ticket') {
      const channel = interaction.channel;

      if (!channel.topic || (!channel.topic.startsWith('ticket:discord:') && !channel.topic.startsWith('ticket:commande:'))) {
        await interaction.reply({ content: '❌ Cette commande ne peut être utilisée que dans un ticket.', ephemeral: true });
      } else {
        await interaction.deferReply();

        const [, currentType, openerId] = channel.topic.split(':');

        if (currentType === 'discord') {
          // Discord -> Commande
          const nextNumber = getNextCommandeNumber();

          await channel.setParent(TICKET_COMMANDE_CATEGORY_ID, { lockPermissions: false });
          await channel.setTopic(`ticket:commande:${openerId}`);
          await channel.setName(buildCommandeChannelName(nextNumber));

          await channel.permissionOverwrites.edit(ROLE_DISCORD_1_ID, { ViewChannel: false });
          await channel.permissionOverwrites.edit(ROLE_DISCORD_2_ID, { ViewChannel: false });
          await channel.permissionOverwrites.edit(ROLE_COMMANDE_ID, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });

          await interaction.editReply({
            content: `🔄 Ticket transféré vers **Support Commande**. <@&${ROLE_COMMANDE_ID}>`,
          });

          await savePersistedData();
        } else {
          // Commande -> Discord
          console.log('[DEBUG transferer-ticket] Début conversion commande -> discord');
          try {
            const opener = await interaction.guild.members.fetch(openerId).catch(() => null);
            const username = opener ? opener.user.username : 'membre';
            console.log('[DEBUG transferer-ticket] Opener récupéré :', username);

            await channel.setParent(TICKET_DISCORD_CATEGORY_ID, { lockPermissions: false });
            console.log('[DEBUG transferer-ticket] setParent OK');

            await channel.setTopic(`ticket:discord:${openerId}`);
            console.log('[DEBUG transferer-ticket] setTopic OK');

            await channel.setName(buildSupportChannelName(username));
            console.log('[DEBUG transferer-ticket] setName OK');

            await channel.permissionOverwrites.edit(ROLE_COMMANDE_ID, { ViewChannel: false });
            console.log('[DEBUG transferer-ticket] overwrite ROLE_COMMANDE_ID OK');

            await channel.permissionOverwrites.edit(ROLE_DISCORD_1_ID, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            });
            console.log('[DEBUG transferer-ticket] overwrite ROLE_DISCORD_1_ID OK');

            await channel.permissionOverwrites.edit(ROLE_DISCORD_2_ID, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            });
            console.log('[DEBUG transferer-ticket] overwrite ROLE_DISCORD_2_ID OK');

            await interaction.editReply({
              content: `🔄 Ticket transféré vers **Support Discord**. <@&${ROLE_DISCORD_1_ID}> <@&${ROLE_DISCORD_2_ID}>`,
            });
            console.log('[DEBUG transferer-ticket] editReply OK - terminé avec succès');
          } catch (err) {
            console.error('[DEBUG transferer-ticket] ERREUR pendant la conversion :', err);
            await interaction.editReply({ content: `❌ Erreur lors du transfert : ${err.message}` }).catch(() => {});
          }
        }
      }
    }

    // --- Commande /verifier-commande : n'importe qui peut vérifier le statut d'une commande ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'verifier-commande') {
      const numero = interaction.options.getString('numero').toUpperCase().trim();
      const order = commandeOrders.get(numero);

      if (!order) {
        await interaction.reply({
          content: `❌ Aucune commande trouvée avec le numéro **${numero}**. Vérifie que tu l'as bien saisi (ex: CMD-1234).`,
          ephemeral: true,
        });
      } else {
        const statusLabel = ORDER_STATUSES[order.status] || order.status;
        await interaction.reply({
          content: `📦 Statut de la commande **${numero}** : ${statusLabel}`,
          ephemeral: true,
        });
      }
    }

    // --- Commande /statut-commande : le staff met à jour le statut de la commande du ticket actuel ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'statut-commande') {
      if (!canLockTicket(interaction.member)) {
        await interaction.reply({ content: '❌ Tu n\'as pas la permission de modifier le statut d\'une commande.', ephemeral: true });
      } else {
        const channel = interaction.channel;

        if (!channel.topic || !channel.topic.startsWith('ticket:')) {
          await interaction.reply({ content: '❌ Cette commande ne peut être utilisée que dans un ticket.', ephemeral: true });
        } else {
          const openerId = channel.topic.split(':')[2];
          const nouveauStatut = interaction.options.getString('statut');

          const result = await applyOrderStatusUpdate({ channel, openerId, nouveauStatut });

          if (result.messageContent) {
            await interaction.reply({ content: result.messageContent, ephemeral: result.ephemeral || false });
          }
        }
      }
    }

    // --- Commande /stats : statistiques du bot (staff uniquement) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
      if (!canLockTicket(interaction.member)) {
        await interaction.reply({ content: '❌ Tu n\'as pas la permission de voir les statistiques.', ephemeral: true });
      } else {
        const openTickets = botStats.ticketsOpened - botStats.ticketsClosed;

        const avgResponseMs = botStats.responseTimes.length > 0
          ? botStats.responseTimes.reduce((a, b) => a + b, 0) / botStats.responseTimes.length
          : null;
        const avgResponseLabel = avgResponseMs
          ? `${Math.round(avgResponseMs / 60000)} minute(s)`
          : 'Pas encore de données';

        const now = new Date();
        const deliveriesThisMonth = botStats.deliveries.filter((d) => {
          const date = new Date(d.timestamp);
          return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        }).length;

        const embed = new EmbedBuilder()
          .setTitle('📊 Statistiques du bot')
          .setColor(0x5865f2)
          .addFields(
            { name: 'Tickets ouverts (total)', value: `${botStats.ticketsOpened}`, inline: true },
            { name: 'Tickets fermés (total)', value: `${botStats.ticketsClosed}`, inline: true },
            { name: 'Tickets actuellement ouverts', value: `${openTickets}`, inline: true },
            { name: 'Temps de réponse moyen', value: avgResponseLabel, inline: true },
            { name: 'Commandes livrées ce mois-ci', value: `${deliveriesThisMonth}`, inline: true },
            { name: 'Total commandes suivies', value: `${commandeOrders.size}`, inline: true },
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      }
    }


    if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
      await interaction.deferReply();

      try {
        const { dynamic, players } = await getFivemStatus();

        const playerList = players
          .slice(0, 20)
          .map(p => `• ${p.name}`)
          .join('\n') || 'Aucun joueur en ligne';

        const embed = new EmbedBuilder()
          .setTitle(dynamic.hostname || 'Serveur FiveM')
          .setColor(0x2ecc71)
          .addFields(
            { name: 'Joueurs', value: `${dynamic.clients} / ${dynamic.sv_maxclients}`, inline: true },
            { name: 'Map', value: dynamic.mapname || 'Inconnue', inline: true },
            { name: 'Mode de jeu', value: dynamic.gametype || 'Inconnu', inline: true },
            { name: 'Liste des joueurs (max 20)', value: playerList },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply('❌ Impossible de récupérer le statut du serveur. Vérifie que le serveur FiveM est en ligne et que l\'IP/le port sont corrects dans le fichier .env.');
      }
    }

    // --- Commande /whitelist : ouvre le formulaire ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'whitelist') {
      const modal = new ModalBuilder()
        .setCustomId('whitelist_modal')
        .setTitle('Candidature Whitelist');

      const ticket = new TextInputBuilder()
        .setCustomId('ticket')
        .setLabel('Lien du ticket de commande (ou /)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Si tu n\'en as pas, mets /')
        .setRequired(true);

      const amiClient = new TextInputBuilder()
        .setCustomId('ami_client')
        .setLabel('Ami(e) d\'un(e) client(e) ? Pseudo Discord')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Si non, mets /')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(ticket),
        new ActionRowBuilder().addComponents(amiClient),
      );

      await interaction.showModal(modal);
    }

    // --- Réception du formulaire de whitelist ---
    if (interaction.isModalSubmit() && interaction.customId === 'whitelist_modal') {
      await interaction.deferReply({ ephemeral: true });

      const ticket = interaction.fields.getTextInputValue('ticket');
      const amiClient = interaction.fields.getTextInputValue('ami_client');

      const embed = new EmbedBuilder()
        .setTitle('Nouvelle candidature whitelist')
        .setColor(0xf1c40f)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: 'Candidat', value: `<@${interaction.user.id}> (${interaction.user.tag})` },
          { name: 'Lien du ticket de commande', value: ticket },
          { name: 'Ami(e) d\'un(e) client(e) ?', value: amiClient },
        )
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`whitelist_accept_${interaction.user.id}`)
          .setLabel('Accepter')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`whitelist_deny_${interaction.user.id}`)
          .setLabel('Refuser')
          .setStyle(ButtonStyle.Danger),
      );

      const staffChannel = await client.channels.fetch(WHITELIST_CHANNEL_ID);
      await staffChannel.send({ embeds: [embed], components: [buttons] });

      await interaction.editReply('✅ Ta candidature a bien été envoyée ! Le staff va l\'examiner.');
    }

    // --- Bouton "Support Discord" : ouvre directement le ticket ---
    if (interaction.isButton() && interaction.customId === 'ticket_open_discord') {
      await interaction.deferReply({ ephemeral: true });
      await createDiscordTicket(interaction);
    }

    // --- Bouton "Support commandes" : ouvre le questionnaire ---
    if (interaction.isButton() && interaction.customId === 'ticket_open_commande') {
      const modal = new ModalBuilder()
        .setCustomId('ticket_commande_modal')
        .setTitle('Ticket commande');

      const typeCommande = new TextInputBuilder()
        .setCustomId('type_commande')
        .setLabel('Type de commande :')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const details = new TextInputBuilder()
        .setCustomId('details')
        .setLabel('Détaillez votre demande :')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(typeCommande),
        new ActionRowBuilder().addComponents(details),
      );

      await interaction.showModal(modal);
    }

    // --- Réception du questionnaire de ticket commande ---
    if (interaction.isModalSubmit() && interaction.customId === 'ticket_commande_modal') {
      await interaction.deferReply({ ephemeral: true });

      const typeCommande = interaction.fields.getTextInputValue('type_commande');
      const details = interaction.fields.getTextInputValue('details');

      await createCommandeTicket(interaction, typeCommande, details);
    }

    // --- Bouton "Verrouiller" le ticket ---
    if (interaction.isButton() && interaction.customId === 'ticket_lock') {
      if (!canLockTicket(interaction.member)) {
        await interaction.reply({ content: '❌ Tu n\'as pas la permission de verrouiller ce ticket.', ephemeral: true });
      } else {
        const channel = interaction.channel;
        const openerId = channel.topic ? channel.topic.split(':')[2] : null;

        if (openerId) {
          await channel.permissionOverwrites.edit(openerId, { SendMessages: false }).catch(() => {});
        }

        const unlockRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_unlock')
            .setLabel('Rouvrir')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔓'),
          new ButtonBuilder()
            .setCustomId('ticket_delete')
            .setLabel('Fermer le ticket')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️'),
        );

        await interaction.update({ components: [unlockRow] });
        await channel.send(`🔒 Ticket verrouillé par <@${interaction.user.id}>.`);
      }
    }

    // --- Bouton "Rouvrir" le ticket ---
    if (interaction.isButton() && interaction.customId === 'ticket_unlock') {
      if (!canLockTicket(interaction.member)) {
        await interaction.reply({ content: '❌ Tu n\'as pas la permission de rouvrir ce ticket.', ephemeral: true });
      } else {
        const channel = interaction.channel;
        const openerId = channel.topic ? channel.topic.split(':')[2] : null;

        if (openerId) {
          await channel.permissionOverwrites.edit(openerId, { SendMessages: true }).catch(() => {});
        }

        const lockRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_lock')
            .setLabel('Verrouiller')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒'),
          new ButtonBuilder()
            .setCustomId('ticket_delete')
            .setLabel('Fermer le ticket')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️'),
        );

        await interaction.update({ components: [lockRow] });
        await channel.send(`🔓 Ticket rouvert par <@${interaction.user.id}>.`);
      }
    }

    // --- Bouton "Fermer le ticket" (suppression) ---
    if (interaction.isButton() && interaction.customId === 'ticket_delete') {
      if (!canLockTicket(interaction.member)) {
        await interaction.reply({ content: '❌ Tu n\'as pas la permission de fermer ce ticket.', ephemeral: true });
      } else {
        await interaction.reply('🗑️ Ce ticket sera fermé et supprimé dans 5 secondes... (transcript en cours de sauvegarde)');
        const channel = interaction.channel;
        await sendTicketTranscript(channel);

        botStats.ticketsClosed += 1;
        ticketCreatedAt.delete(channel.id);
        ticketResponded.delete(channel.id);
        await savePersistedData();

        setTimeout(() => {
          channel.delete().catch(() => {});
        }, 5000);
      }
    }


    if (interaction.isButton() && interaction.customId.startsWith('whitelist_')) {
      const [, action, userId] = interaction.customId.split('_');

      const member = await interaction.guild.members.fetch(userId).catch(() => null);

      if (action === 'accept') {
        if (member) {
          await member.roles.add(WHITELIST_ROLE_ID).catch((err) => {
            console.error('❌ Impossible d\'attribuer le rôle automatiquement :', err);
          });
          await member.send('🎉 Ta candidature whitelist a été **acceptée** ! Tu peux maintenant rejoindre le serveur.').catch(() => {});
        }

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0x2ecc71)
          .setFooter({ text: `Acceptée par ${interaction.user.tag}` });

        await interaction.update({ embeds: [updatedEmbed], components: [] });
      }

      if (action === 'deny') {
        if (member) {
          await member.send('❌ Ta candidature whitelist a été **refusée**. Tu peux contacter le staff pour plus d\'informations.').catch(() => {});
        }

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0xe74c3c)
          .setFooter({ text: `Refusée par ${interaction.user.tag}` });

        await interaction.update({ embeds: [updatedEmbed], components: [] });
      }
    }
  } catch (error) {
    console.error('❌ ERREUR dans interactionCreate :', error);
  }
});

// ----------------------------------------------------
// Petit serveur web (nécessaire pour Render / hébergeurs gratuits)
// + API pour mettre à jour le statut d'une commande depuis un script externe (FiveM/txAdmin)
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';

// --- Connexion Discord (OAuth2) pour le site staff ---
const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const BOT_BASE_URL = 'https://fivem-bot-li92.onrender.com';
const SITE_URL = 'https://yamastreat.github.io/storm-site/';
const SITE_ORIGIN = 'https://yamastreat.github.io';
const OAUTH_REDIRECT_URI = `${BOT_BASE_URL}/auth/discord/callback`;

const oauthStates = new Map(); // state temporaire -> expiration (anti-CSRF)
const sessions = new Map(); // sessionId -> { userId, username, expiresAt }
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 heures

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    cookies[key] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['storm_session'];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

http.createServer((req, res) => {
  // --- CORS : autorise ton site web (et uniquement lui) à appeler cette API avec les cookies de session ---
  res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  function checkApiKey() {
    return API_SECRET && req.headers['x-api-key'] === API_SECRET;
  }

  function checkStaffSession() {
    const session = getSession(req);
    return !!session;
  }

  // --- GET /auth/discord/login : redirige vers Discord pour se connecter ---
  if (req.method === 'GET' && pathname === '/auth/discord/login') {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now() + 5 * 60 * 1000); // valable 5 minutes

    const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
    authorizeUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'identify');
    authorizeUrl.searchParams.set('state', state);

    res.writeHead(302, { Location: authorizeUrl.toString() });
    res.end();
    return;
  }

  // --- GET /auth/discord/callback : Discord revient ici après connexion ---
  if (req.method === 'GET' && pathname === '/auth/discord/callback') {
    const code = parsedUrl.searchParams.get('code');
    const state = parsedUrl.searchParams.get('state');

    (async () => {
      try {
        const stateExpiry = oauthStates.get(state);
        oauthStates.delete(state);
        if (!code || !stateExpiry || stateExpiry < Date.now()) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Connexion invalide ou expirée.</h1><p>Réessaie depuis le site.</p>');
          return;
        }

        // Échange le code contre un access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: OAUTH_REDIRECT_URI,
          }),
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
          console.error('[OAuth] Échec de l\'échange du code :', tokenData);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Échec de la connexion Discord.</h1>');
          return;
        }

        // Récupère l'identité de l'utilisateur
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userRes.json();

        // Vérifie que la personne est bien staff (via le bot, déjà connecté au serveur)
        const guild = client.guilds.cache.first();
        const member = await guild.members.fetch(userData.id).catch(() => null);

        if (!member || !canLockTicket(member)) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Accès refusé.</h1><p>Ce site est réservé au staff de S.T.O.R.M. Studio.</p>');
          return;
        }

        // Crée la session
        const sessionId = crypto.randomBytes(24).toString('hex');
        sessions.set(sessionId, {
          userId: userData.id,
          username: userData.username,
          expiresAt: Date.now() + SESSION_DURATION_MS,
        });

        res.writeHead(302, {
          'Set-Cookie': `storm_session=${sessionId}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}`,
          Location: SITE_URL,
        });
        res.end();
      } catch (err) {
        console.error('[OAuth] Erreur callback :', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Erreur interne lors de la connexion.</h1>');
      }
    })();
    return;
  }

  // --- GET /auth/me : le site vérifie si la personne est connectée ---
  if (req.method === 'GET' && pathname === '/auth/me') {
    const session = getSession(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(
      session ? { loggedIn: true, username: session.username } : { loggedIn: false }
    ));
    return;
  }

  // --- POST /auth/logout : déconnexion ---
  if (req.method === 'POST' && pathname === '/auth/logout') {
    const cookies = parseCookies(req);
    if (cookies['storm_session']) {
      sessions.delete(cookies['storm_session']);
    }
    res.writeHead(200, {
      'Set-Cookie': 'storm_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- GET /api/status : statut du serveur FiveM (public) ---
  if (req.method === 'GET' && pathname === '/api/status') {
    getFivemStatus()
      .then(({ dynamic }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          online: true,
          hostname: dynamic.hostname,
          players: dynamic.clients,
          maxPlayers: dynamic.sv_maxclients,
        }));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, online: false }));
      });
    return;
  }

  // --- GET /api/order?numero=CMD-1234 : statut d'une commande (public) ---
  if (req.method === 'GET' && pathname === '/api/order') {
    const numero = (parsedUrl.searchParams.get('numero') || '').toUpperCase().trim();
    const order = commandeOrders.get(numero);

    if (!order) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Commande introuvable' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      numero: order.numero,
      statut: order.status,
      statutLabel: ORDER_STATUSES[order.status] || order.status,
    }));
    return;
  }

  // --- GET /api/tickets : liste de toutes les commandes/tickets (protégé) ---
  if (req.method === 'GET' && pathname === '/api/tickets') {
    if (!checkApiKey() && !checkStaffSession()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Non autorisé' }));
      return;
    }

    const tickets = Array.from(commandeOrders.values()).map((order) => ({
      numero: order.numero,
      statut: order.status,
      statutLabel: ORDER_STATUSES[order.status] || order.status,
      ticketChannelId: order.ticketChannelId,
      closedAt: order.closedAt || null,
      hasTranscript: !!order.transcriptUrl,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tickets }));
    return;
  }

  // --- GET /api/transcript?numero=CMD-1234 : lien du transcript (protégé) ---
  if (req.method === 'GET' && pathname === '/api/transcript') {
    if (!checkApiKey() && !checkStaffSession()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Non autorisé' }));
      return;
    }

    const numero = (parsedUrl.searchParams.get('numero') || '').toUpperCase().trim();
    const order = commandeOrders.get(numero);

    if (!order || !order.transcriptUrl) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Aucun transcript disponible pour cette commande' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, numero: order.numero, transcriptUrl: order.transcriptUrl, closedAt: order.closedAt }));
    return;
  }

  // --- Endpoint pour mettre à jour une commande depuis l'extérieur ---
  if (req.method === 'POST' && req.url === '/update-order') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        if (!API_SECRET || req.headers['x-api-key'] !== API_SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Clé API invalide' }));
          return;
        }

        const payload = JSON.parse(body);
        const numero = (payload.numero || '').toUpperCase().trim();
        const nouveauStatut = payload.statut;

        if (!numero || !['en_attente', 'en_cours', 'livree'].includes(nouveauStatut)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Paramètres invalides (numero + statut requis)' }));
          return;
        }

        console.log(`[API update-order] Requête reçue : numero=${numero}, statut=${nouveauStatut}`);

        const order = commandeOrders.get(numero);
        if (!order) {
          console.log(`[API update-order] Commande ${numero} introuvable dans commandeOrders (taille actuelle : ${commandeOrders.size})`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Commande ${numero} introuvable` }));
          return;
        }
        console.log(`[API update-order] Commande trouvée, ticketChannelId=${order.ticketChannelId}`);

        const channel = await client.channels.fetch(order.ticketChannelId).catch((err) => {
          console.error('[API update-order] Erreur fetch du salon :', err.message);
          return null;
        });
        if (!channel) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Salon du ticket introuvable (peut-être déjà fermé)' }));
          return;
        }
        console.log(`[API update-order] Salon trouvé : ${channel.name}`);

        const result = await applyOrderStatusUpdate({ channel, openerId: order.userId, nouveauStatut });
        console.log(`[API update-order] applyOrderStatusUpdate terminé, messageContent=${!!result.messageContent}, ephemeral=${result.ephemeral}`);

        if (result.messageContent && !result.ephemeral) {
          try {
            await channel.send({ content: result.messageContent });
            console.log('[API update-order] Message envoyé avec succès dans le salon');
          } catch (sendErr) {
            console.error('[API update-order] ❌ ERREUR lors de l\'envoi du message :', sendErr);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, numero, statut: nouveauStatut }));
      } catch (err) {
        console.error('❌ Erreur API /update-order :', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Erreur interne' }));
      }
    });
    return;
  }

  // --- Route par défaut (utilisée par Render / UptimeRobot) ---
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot en ligne !');
}).listen(PORT, () => {
  console.log(`Serveur web de statut actif sur le port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
