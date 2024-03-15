const maintenanceMode = false;
const maintenanceModeMessage = `The bot is currently in maintenance mode.
Your conversation will continue as normal once work is complete.
Please try again in five minutes.`;
const mods = ['anon.mod#0', 'auekha#0'];
import { PrismaClient, PrismaPromise, User } from '@prisma/client';
import { Client, IntentsBitField, CacheType, Partials } from 'discord.js';
import { Interaction, Message, PartialMessage, Typing } from 'discord.js';
import { ColorResolvable, EmbedBuilder, APIEmbedField } from 'discord.js';
import { TextBasedChannel, ChannelType, User as DUser } from 'discord.js';
import { BaseMessageOptions, ClientEvents, GuildMember } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, GatewayIntentBits } from 'discord.js';
import { CommandInteraction, ButtonInteraction } from 'discord.js';
import { ChangeGender, Gender, GenderEmbed, GenderSeeking } from './gender';
import { cacheAdd, cacheHas, failable, resilience } from './util';
import * as dotenv from 'dotenv';
dotenv.config();
const linkRegex = /(https?|discord\.gg|discord\.com).+?($|\s)/;
const yesterday = () => new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
const oneMinuteAgo = () => new Date(new Date().getTime() - 60 * 1000);

const client = new Client({
  intents: [
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.DirectMessageTyping,
    IntentsBitField.Flags.DirectMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});
const prisma = new PrismaClient();
type HistoricalConvo = {
  userId?: number;
  at: Date;
  waitMin: number;
  sexFlags: User['sexFlags'];
};
const historicalMatches: HistoricalConvo[] = [];
let newConvoSemaphore = false;

const trimHistoricalConvos = () => {
  while (historicalMatches.length && historicalMatches[0]!.at < yesterday()) {
    historicalMatches.shift();
  }
};

const transaction = async (...actions: PrismaPromise<any>[]) =>
  await resilience(async () => await prisma.$transaction(actions));

const userUpdate = async (
  params: Parameters<(typeof prisma)['user']['update']>[0],
) => resilience(() => prisma.user.update(params));

const userBlock = failable(async (blockerId: number, blockedId: number) => {
  await transaction(
    prisma.block.create({ data: { blockerId, blockedId } }),
    prisma.user.update({
      data: { prevWithId: null },
      where: { id: blockerId },
    }),
  );
});

async function MarkInaccessible(id: number, banned?: boolean) {
  const data = {
    accessible: false,
    seekingSince: null,
    greeting: null,
    banned,
  };
  await userUpdate({ where: { id }, data });
}

const Inaccessibility = (id: number) => () => MarkInaccessible(id);

export async function MakeEmbed(
  title: string,
  params: {
    colour?: ColorResolvable;
    fields?: APIEmbedField[];
    rows?: ActionRowBuilder<ButtonBuilder>[];
    footer?: boolean;
    content?: string;
  },
  body?: string,
) {
  const { colour = '#0099ff', fields, rows = [], footer, content } = params;
  const embed = new EmbedBuilder().setColor(colour).setTitle(title);
  if (body) embed.setDescription(body);
  fields?.forEach(x => embed.addFields(x));
  if (footer) {
    await MakeEmbedFooter()(embed);
  }
  return { embeds: [embed], components: rows, content };
}

const MakeEmbedFooter = failable(_MakeEmbedFooter);
async function _MakeEmbedFooter(embed: EmbedBuilder) {
  const {
    _count: { accessible: nu },
    _sum: { numConvo: nc, numMessage: nm },
  } = await prisma.user.aggregate({
    _count: { accessible: true },
    _sum: { numConvo: true, numMessage: true },
  });
  const [numUser, numConvo, numMessage] = [
    nu,
    nc != null ? nc / 2 : null,
    nm,
  ].map(x =>
    x !== null
      ? `${(x / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k`
      : '--',
  );
  const recentConvos = () => {
    trimHistoricalConvos();
    const [earliestMatch] = historicalMatches;
    if (!earliestMatch) return '';
    const numConvoRecently = historicalMatches.length / 2;
    const numConvoDurationHours = Math.ceil(
      (Date.now() - earliestMatch.at.getTime()) / 3600000,
    );
    return `\n${numConvoRecently} convos in the last ${numConvoDurationHours} hours.`;
  };
  embed.setFooter({
    text: `${numUser} strangers; ${numConvo} convos, ${numMessage} messages ever.${recentConvos()}`,
  });
}

function UserStatsEmbedFields(user: User, name: string) {
  const ls = (n: number) => n.toLocaleString();
  const numDays = Number((BigInt(Date.now()) - user.createdAt) / 86400000n);
  const numDaysStr =
    numDays < 1
      ? 'today'
      : numDays < 2
      ? 'yesterday'
      : `${ls(numDays)} days ago`;
  const numConvo = ls(user.numConvo);
  const numMsg = ls(user.numMessage);
  const value = `Joined ${numDaysStr}; ${numConvo} convos, ${numMsg} messages.`;
  return { name, value };
}

const SendEmbed = failable(
  async (channel: TextBasedChannel, ...args: Parameters<typeof MakeEmbed>) =>
    await channel.send(await MakeEmbed(...args)),
);

async function TouchUser({ id, tag }: DUser) {
  return await resilience(
    async () =>
      await prisma.user.upsert({
        where: { snowflake: BigInt(id) },
        update: { lastSeenAt: new Date().getTime(), tag, accessible: true },
        create: { createdAt: new Date().getTime(), tag, snowflake: BigInt(id) },
      }),
  );
}

const GetUserChannel = failable(async (id: number) => {
  const { snowflake } = await prisma.user.findFirstOrThrow({ where: { id } });
  const member = await client.users.fetch(`${snowflake}`);
  return await member.createDM(true);
});

//TODO: make failable
/** Ends user's conversation, or if not in one stops seeking for one. */
async function EndConvo(
  { tag, id, convoWithId }: User,
  reason: 'stop' | 'block' | 'ban' | 'inaccessible',
  partnerInaccessible = false,
) {
  console.log(Date.now(), 'EndConvo ', tag, id, convoWithId, reason);
  if (convoWithId) {
    //Update partners
    const data = { convoWithId: null, seekingSince: null };
    await transaction(
      prisma.user.update({ where: { id }, data }),
      prisma.user.update({ where: { id: convoWithId }, data }),
    );
    //Inform partner
    const onFail = Inaccessibility(id);
    if (partnerInaccessible) {
      await MarkInaccessible(convoWithId);
    } else {
      const partnerChannel = await GetUserChannel(onFail)(convoWithId);
      if (partnerChannel) {
        await SendEmbed(onFail)(
          partnerChannel,
          'Your partner left the conversation.',
          { colour: 'Red', footer: true },
          'Send a message to start a new conversation.',
        );
      }
    }
    return convoWithId;
  } else {
    //Stop seeking
    const data = { seekingSince: null, greeting: null };
    await userUpdate({ where: { id }, data });
  }
}

const Minutes = (min: number) =>
  min === 1 ? 'less than a minute' : `${min} minutes`;

const minutesSince = (date: Date) =>
  (new Date().getTime() - date.getTime()) / 1000 / 60;

const JoinConvo = failable(_JoinConvo);
async function _JoinConvo(
  user: User,
  partner: User,
  greeting: Message,
  partnerChannel: TextBasedChannel,
) {
  console.log(Date.now(), 'JoinConvo', user.tag, partner.tag);
  const { id, snowflake, sexFlags } = user;
  const waitMin = Math.ceil(minutesSince(partner.seekingSince!));
  const waitMinText = Minutes(waitMin);
  //Generate stats
  const { gender: youGender, seeking: youSeeking } = GenderSeeking(sexFlags);
  const { gender: themGender, seeking: themSeeking } = GenderSeeking(
    partner.sexFlags,
  );
  const seeking = (
    who: 'you' | 'them',
    seeking: (Gender | 'anyone')[],
    gender?: Gender,
  ) => {
    const genderedPronoun = gender
      ? { male: 'Him', female: 'Her', 'non-binary': 'Them' }[gender]
      : 'Them';
    const pronoun = who === 'you' ? 'You' : genderedPronoun;
    const seeks = seeking.join(' + ');
    return `${pronoun} – ${gender ? `${gender} ` : ''}seeking ${seeks}`;
  };
  const yourFields = [
    UserStatsEmbedFields(user, seeking('you', youSeeking, youGender)),
    UserStatsEmbedFields(partner, seeking('them', themSeeking, themGender)),
  ];
  const theirFields = [
    UserStatsEmbedFields(partner, seeking('you', themSeeking, themGender)),
    UserStatsEmbedFields(user, seeking('them', youSeeking, youGender)),
  ];
  const matchEmbed = async (name: 'you' | 'them') =>
    await MakeEmbed(
      'You have been matched with a partner!',
      { colour: 'Green', fields: name === 'you' ? yourFields : theirFields },
      `It took **${waitMinText}** for this match to be found.
Use \`/stop\` to disconnect.
Use \`/block\` to disconnect and block them.
Use \`/gender\` to match particular genders.`,
    );
  //Inform users and exchange greetings
  //(This partner send will throw if the partner left after looking for a convo)
  await partnerChannel.send(await matchEmbed('them'));
  await greeting.channel.send(await matchEmbed('you'));
  if (partner.greeting) {
    AuditMessage()(
      await greeting.channel.send(partner.greeting),
      partner,
      user.id,
    );
  }
  await partnerChannel.send(
    greeting.content || '[Your partner sent no greeting text]',
  );
  AuditMessage()(greeting, user, partner.id);
  //Update database
  const updateData = {
    seekingSince: null,
    greeting: null,
    numConvo: { increment: 1 },
    numMessage: { increment: 1 },
  };
  await transaction(
    prisma.user.update({
      where: { snowflake },
      data: { convoWithId: partner.id, prevWithId: partner.id, ...updateData },
    }),
    prisma.user.update({
      where: { id: partner.id },
      data: { convoWithId: id, prevWithId: user.id, ...updateData },
    }),
  );
  //Cache wait times, and who joined immediately to mitigate spam
  const at = new Date();
  historicalMatches.push({ userId: id, at, waitMin, sexFlags });
  historicalMatches.push({ at, waitMin, sexFlags: partner.sexFlags });
  trimHistoricalConvos();
}

async function HandlePotentialCommand(
  commandName: string,
  user: User,
  reply: (
    onFail?: () => Promise<void>,
  ) => (message: BaseMessageOptions) => Promise<void>,
  arg?: string,
) {
  let embed: Awaited<ReturnType<typeof MakeEmbed>> | null = null;
  if (commandName === 'stop') {
    const wasInConvo = await EndConvo(user, 'stop');
    embed = await MakeEmbed(
      wasInConvo
        ? 'You have disconnected'
        : user.seekingSince
        ? 'You are no longer seeking'
        : "You aren't in a conversation",
      { colour: '#ff00ff', footer: !!wasInConvo },
      `Send a message to start a new conversation.${
        wasInConvo
          ? '\nSend `/block` to block who you were just talking to.'
          : ''
      }`,
    );
  }
  if (commandName === 'block') {
    const wasInConvoWith = await EndConvo(user, 'block');
    if (wasInConvoWith) {
      embed = await MakeEmbed(
        'Disconnected and blocked',
        { colour: '#00ffff' },
        'You will never match with them again.\nSend a message to start a new conversation.',
      );
      await userBlock(
        async () => (embed = await MakeEmbed("Sorry, that didn't work", {})),
      )(user.id, wasInConvoWith);
    } else {
      const { prevWithId } = user;
      if (prevWithId) {
        embed = await MakeEmbed(
          'Blocked your previous partner',
          { colour: '#00ffff' },
          'You will never match with them again.\nSend a message to start a new conversation.',
        );
        await userBlock(
          async () => (embed = await MakeEmbed("Sorry, that didn't work", {})),
        )(user.id, prevWithId);
      } else {
        embed = await MakeEmbed(
          "You aren't in a conversation",
          { colour: 'Red' },
          'Send a message to start a new conversation.',
        );
      }
    }
  }
  if (commandName === 'gender') {
    embed = await GenderEmbed(user);
  }
  if (commandName === 'ban' && mods.includes(user.tag)) {
    const wasInConvoWith = await EndConvo(user, 'ban');
    if (wasInConvoWith) {
      await MarkInaccessible(wasInConvoWith, true);
      embed = await MakeEmbed('Done.', { colour: 'Green' });
    }
  }
  if (embed) await reply(Inaccessibility(user.id))(embed);
}

function EstWaitMessage(sexFlags: User['sexFlags']) {
  //Average of historical wait times for these sexFlags
  const withSexFlags: Extract<HistoricalConvo, { sexFlags: number }>[] = [];
  historicalMatches.forEach(x => 'sexFlags' in x && withSexFlags.push(x));
  const filtered = withSexFlags.filter(x => x.sexFlags === sexFlags);
  if (!filtered.length) return '';
  const sumMin = filtered.reduce((a, b) => a + b.waitMin, 0);
  const numWait = filtered.length;
  const estMin = Math.round(sumMin / numWait);
  const disclaimer =
    sexFlags === 0b00111111 ? '' : ' for your gender preferences';
  return `Estimated wait${disclaimer}: **${Minutes(estMin)}**.
`;
}

async function StartConvo(
  user: User,
  partner: User,
  message: Message,
  newSexFlags: number,
) {
  const { sexFlags } = user;
  let failed = false;
  const onFail = async () => {
    await EndConvo(user, 'inaccessible'); //For good measure
    await MarkInaccessible(partner.id);
    failed = true;
  };
  //Attempt to join a conversation (fails if partner left after seeking)
  const partnerChannel = await GetUserChannel(onFail)(partner.id);
  if (!partnerChannel) return;
  await JoinConvo(onFail)(user, partner, message, partnerChannel);
  if (failed) return;
  if (sexFlags !== newSexFlags) {
    const tried = GenderSeeking(sexFlags).seeking.join(' + ');
    console.log('switched to seeking anyone for', user.tag);
    await message.reply(
      `There were too many people waiting to match with ${tried}. You have been matched with anyone instead.`,
    );
  }
  return true;
}

async function StartSeeking(user: User, message: Message) {
  if (Number.isInteger(Math.log2(user?.numConvo ?? 0))) {
    try {
      await message.channel.send(
        'Why not join our hang-out while you wait?\nhttps://discord.gg/BbPkC9ATrq',
      );
    } catch (e) {}
  }
  const estWaitMessage = EstWaitMessage(user.sexFlags);
  await SendEmbed(Inaccessibility(user.id))(
    message.channel,
    'Waiting for a partner match...',
    { footer: true },
    `${estWaitMessage}Your message will be sent to them.
To cancel, use \`/stop\`.`,
  );
  const { snowflake } = user;
  await userUpdate({
    where: { snowflake },
    data: { seekingSince: new Date(), greeting: message.content },
  });
}

//TODO: make failable
async function FindConvo(user: User, message: Message) {
  while (newConvoSemaphore) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  newConvoSemaphore = true;
  const { id, snowflake, sexFlags } = user;
  //Check how many others are using the same sexFlags (if not seeking any)
  let newSexFlags = sexFlags;
  if ((sexFlags & 7) !== 7) {
    const numSexSeekQuery = await prisma.$queryRaw<{ numSexSeek: BigInt }[]>`
      SELECT COUNT(1) "numSexSeek" FROM "User"
      WHERE accessible = true
      AND convoWithId IS NULL
      AND seekingSince IS NOT NULL
      AND sexFlags & 7 != 7
      AND sexFlags & 7 = ${sexFlags & 7}
    `;
    const numSexSeek = Number(numSexSeekQuery[0]!.numSexSeek);
    //Seek anybody if 5 or more are seeking the same sex
    if (numSexSeek > 4) {
      newSexFlags = (newSexFlags & 0b111000) | 7;
    }
  }
  let timeout = 5;
  while (--timeout) {
    const [partner] = await prisma.$queryRaw<User[]>`
      SELECT * FROM "User"
      WHERE accessible = true
      AND convoWithId IS NULL
      AND snowflake != ${snowflake}
      AND seekingSince IS NOT NULL
      AND (prevWithId IS NULL OR prevWithId != ${id})
      AND NOT EXISTS (
        SELECT * FROM "Block"
        WHERE blockerId = ${id} AND blockedId = "User".id
      )
      AND NOT EXISTS (
        SELECT * FROM "Block"
        WHERE blockerId = "User".id AND blockedId = ${id}
      )
      AND ((${newSexFlags} & 7) & (sexFlags >> 3)) AND NOT (~(${newSexFlags} & 7) & (sexFlags >> 3))
      AND ((sexFlags & 7) & (${newSexFlags} >> 3)) AND NOT (~(sexFlags & 7) & (${newSexFlags} >> 3))
      ORDER BY seekingSince ASC
      LIMIT 1
    `;
    if (partner) {
      if (!(await StartConvo(user, partner, message, newSexFlags))) {
        continue;
      }
    } else {
      await StartSeeking(user, message);
    }
    break;
  }
  if (!timeout) {
    console.error('Timeout finding convo for', user.id);
    await message.reply(
      'Sorry, there was a problem finding a partner. Please try again.',
    );
  }
  newConvoSemaphore = false;
}

async function HandleCommandInteraction(interaction: CommandInteraction) {
  const { commandName, channel } = interaction;
  const user = await TouchUser(interaction.user);
  if (!channel || !user) return;
  if (channel.type !== ChannelType.DM) {
    try {
      await interaction.reply({
        content: 'Please use this command in DMs with me.',
        ephemeral: true,
      });
    } catch (e) {}
    return;
  }
  await HandlePotentialCommand(
    commandName,
    user,
    failable(async x => {
      await interaction.reply(x);
    }),
  );
}

async function HandleButtonInteraction(interaction: ButtonInteraction) {
  const { customId } = interaction;
  const user = await TouchUser(interaction.user);
  if (!user) return;
  await ChangeGender(
    async () =>
      await interaction.reply('There was a problem. Please try again.'),
  )(prisma, user, customId);
  await interaction.update(await GenderEmbed(user));
}

async function MakeContext() {
  //Circular buffer to keep track of message edits
  const msgToMsg: { a: Message; b: Message }[] = [];
  //Circular buffer to slow down repetitive messages [id, timestamp]
  const userMsgs: [number, number][] = [];

  async function GetM2M(message: Message | PartialMessage) {
    const m2m = msgToMsg.find(({ a, b }) => [a.id, b.id].includes(message.id));
    if (!m2m) return;
    const partnerMessage = m2m.a.id === message.id ? m2m.b : m2m.a;
    return partnerMessage;
  }

  async function ResolveReply({ reference, channel }: Message) {
    if (!reference) return;
    const replied = await channel.messages.fetch(`${reference.messageId}`);
    const partnerMessage = await GetM2M(replied);
    if (!partnerMessage) return;
    return { messageReference: partnerMessage };
  }

  async function ForwardMessage(message: Message, sender: User) {
    const { id, convoWithId } = sender;
    if (!message.content && !message.attachments.size) return true;
    try {
      if (convoWithId === null) return 'No convo';
      const onFail = Inaccessibility(convoWithId);
      const partnerChannel = await GetUserChannel(onFail)(convoWithId);
      if (!partnerChannel) return 'Partner left';
      const reply = await ResolveReply(message);
      const partnerMessage = await partnerChannel.send({
        content: message.content,
        embeds: message.embeds,
        files: message.attachments.map(a => a.url),
        reply,
      });
      //Increment message count
      await userUpdate({
        where: { id },
        data: { numMessage: { increment: 1 } },
      });
      //Add both message to message cache for edits, replies, and emojis
      msgToMsg.push({ a: message, b: partnerMessage });
      while (msgToMsg.length > 2_000) {
        msgToMsg.shift();
      }
      AuditMessage()(message, sender, convoWithId);
      return true;
    } catch (e: any) {
      console.log('Partner left error', 'rawError' in e ? e.rawError : e);
      return 'Partner left';
    }
  }

  return {
    async HandleMessageCreate(message: Message) {
      if (message.author.bot) return;
      if (message.channel.type !== ChannelType.DM) return;
      if (maintenanceMode && !mods.includes(message.author.tag)) {
        await message.reply(maintenanceModeMessage);
        console.log('Maintenance mode informed', message.author.tag);
        return;
      }
      //Touch user
      const user = await TouchUser(message.author);
      if (!user) return;
      if (user.banned) {
        await message.reply('You are banned from using this bot.');
        return;
      }
      if (/^[/!]/.test(message.content)) {
        const [_, commandName, arg] =
          message.content.trim().match(/^(?:\/|!)(\w+)(?:\s([\s\S]+))?/) ?? [];
        const reply = failable(async (x: BaseMessageOptions) => {
          await message.reply(x);
        });
        if (commandName)
          await HandlePotentialCommand(commandName, user, reply, arg);
        return;
      }
      //Disallow links for users with fewer than ten conversations
      if (user.numConvo < 10 && linkRegex.exec(message.content)?.[0]) {
        await message.reply(
          `Sorry, you need to have at least ten conversations before you can send links.
This is to help mitigate spam.`,
        );
        return;
      }
      //Disallow messages from those who have sent more than six messages in the last half minute
      const halfMinuteAgo = new Date(Date.now() - 30_000).getTime();
      const userMessages = userMsgs.filter(
        ([id, time]) => id === user.id && time > halfMinuteAgo,
      );
      if (userMessages.length > 6) {
        await message.reply(
          `Sorry, you need to wait half a minute before sending another message.
This is to help mitigate spam.`,
        );
        return;
      }
      userMsgs.push([user.id, new Date().getTime()]);
      while (userMsgs.length > 100) {
        userMsgs.shift();
      }
      //Forward messages
      const forwardResult = await ForwardMessage(message, user);
      if (forwardResult === 'No convo') {
        //Prevent links from starting conversations
        if (
          message.content.match(linkRegex) &&
          !message.content.includes('attachment')
        ) {
          return;
        }
        //Mitigate join-leave sprees
        const latestConvo = [...historicalMatches]
          .reverse()
          .find(x => x.userId === user.id);
        if (
          latestConvo &&
          latestConvo.at.getTime() > oneMinuteAgo().getTime()
        ) {
          await message.reply(
            `Sorry, you need to wait one minute after your previous conversation.
This is to help mitigate spam.`,
          );
          return;
        }
        //Start or join a conversation
        await FindConvo(user, message);
      }
      if (forwardResult === 'Partner left') {
        //End conversation
        await EndConvo(user, 'inaccessible', true);
        //Inform user
        await SendEmbed(() => MarkInaccessible(user.id))(
          message.channel,
          'Sorry, but your partner left the conversation.',
          { colour: '#ff4444', footer: true },
          'Send a message to start a new conversation.',
        );
      }
    },
    async HandleInteractionCreate(interaction: Interaction<CacheType>) {
      if (maintenanceMode && !mods.includes(interaction.user.tag)) {
        await interaction.channel?.send(maintenanceModeMessage);
        console.log('Maintenance mode informed', interaction.user.tag);
        return;
      }
      if (interaction.isCommand()) await HandleCommandInteraction(interaction);
      if (interaction.isButton()) await HandleButtonInteraction(interaction);
    },
    async HandleTypingStart({ channel, user: dUser }: Typing) {
      if (cacheHas(channel.id) || dUser.bot || !dUser.tag) return;
      const user = await TouchUser(dUser);
      if (!user?.convoWithId) return;
      cacheAdd(channel.id, 5_000);
      const onFail = Inaccessibility(user.convoWithId);
      const partnerChannel = await GetUserChannel(onFail)(user.convoWithId);
      await partnerChannel?.sendTyping();
    },
    async HandleMessageUpdate(
      oldMessage: Message<boolean> | PartialMessage,
      newMessage?: Message<boolean> | PartialMessage,
    ) {
      if (oldMessage.author?.bot || oldMessage.channel.type !== ChannelType.DM)
        return;
      const parterMessage = await GetM2M(oldMessage);
      if (!parterMessage) return;
      parterMessage?.edit(newMessage?.content ?? '[deleted]');
    },
    async HandleReactionAdd(
      ...[{ message, emoji }, user]: ClientEvents['messageReactionAdd']
    ) {
      if (user.bot) return;
      const partnerMessage = await GetM2M(message);
      if (!partnerMessage) return;
      try {
        await partnerMessage.react(emoji);
      } catch (e) {} //Custom emoji, invalid emoji, etc.
    },
    async HandleReactionRemove(
      ...[{ message, emoji }, user]: ClientEvents['messageReactionRemove']
    ) {
      if (user.bot || !client.user) return;
      const partnerMessage = await GetM2M(message);
      if (!partnerMessage) return;
      await partnerMessage.reactions.cache
        .find(x => x.emoji.name === emoji.name)
        ?.users.remove(client.user.id);
    },
    async HandleGuildMemberAdd(member: GuildMember) {
      //Don't attempt to onboard Deadline members
      if (member.guild.id === '608406913016791073') {
        return;
      }
      const embed = (inChannel: boolean) =>
        [
          'Welcome!',
          {
            colour: '#00ff00',
            footer: true,
            content: inChannel ? `<@${member.id}>` : undefined,
          },
          `I'm a bot that connects you to random people in DMs.
Send me a message to start a conversation.${
            inChannel
              ? `
Ensure that you have DMs enabled for this server and that you're not blocking me.`
              : ''
          }`,
        ] as const;
      try {
        await member.send(await MakeEmbed(...embed(false)));
      } catch (e) {
        const sf = {
          '981158595339116564': '981158595339116567',
          //'971115937258430506': '1062131286296248411',
        }[member.guild.id];
        if (!sf) return;
        const welcomeChannel = await member.guild.channels.fetch(sf);
        if (!welcomeChannel?.isTextBased()) return;
        await SendEmbed()(welcomeChannel, ...embed(true));
      }
      await TouchUser(member.user);
    },
  };
}

const AuditMessage = failable(_AuditMessage);
async function _AuditMessage(message: Message, from: User, toId: number) {
  const guildSf = process.env.AUDIT_GUILD_SF;
  const channelSf = process.env.AUDIT_CHANNEL_SF;
  if (!guildSf) {
    console.warn('No audit guild SF');
    return;
  }
  if (!channelSf) {
    console.warn('No audit channel SF');
    return;
  }
  const guild = await client.guilds.fetch(guildSf);
  if (!guild) {
    console.error(`No guild ${process.env.AUDIT_SERVER_SF}`);
    return;
  }
  const auditChannel = await guild.channels.fetch(
    process.env.AUDIT_CHANNEL_SF!,
  );
  if (!auditChannel?.isTextBased()) {
    console.error(`No audit channel ${process.env.AUDIT_CHANNEL_SF}`);
    return;
  }
  const auditAttachmentChannel = await guild.channels.fetch(
    process.env.AUDIT_IMAGE_CHANNEL_SF!,
  );
  if (!auditAttachmentChannel?.isTextBased()) {
    console.error(
      `No attachment audit channel ${process.env.AUDIT_ATTACHMENT_CHANNEL_SF}`,
    );
    return;
  }

  const attachments = message.attachments.map(x => x.url).join('\n');
  message.attachments.forEach(attachment =>
    auditAttachmentChannel.send({
      files: [attachment],
    }),
  );

  const convoId = [...`${from.id + toId}`]
    .reverse()
    .slice(0, 3)
    .join('')
    .padStart(3, '0');
  const userId = from.id.toString(16).padStart(7, '0');
  const partnerId = toId.toString(16).padStart(7, '0');
  const info = `${convoId} ${userId} ${partnerId} ${from.tag}`;
  await auditChannel.send(`\`${info}\` ${message.content}\n${attachments}`);
}

async function main() {
  console.log('Loading.');
  client.once('ready', async () => {
    const ctx = await MakeContext();

    client.application?.commands.create({
      name: 'stop',
      description: 'Disconnect from partner / stop looking for a new one',
    });
    client.application?.commands.create({
      name: 'block',
      description: 'Disconnect and never connect to this partner again',
    });
    client.application?.commands.create({
      name: 'gender',
      description: 'Set your gender and gender preferences',
    });

    client.on('messageCreate', ctx.HandleMessageCreate);
    client.on('interactionCreate', ctx.HandleInteractionCreate);
    client.on('typingStart', ctx.HandleTypingStart);
    client.on('messageUpdate', ctx.HandleMessageUpdate);
    client.on('messageDelete', ctx.HandleMessageUpdate);
    client.on('messageReactionAdd', ctx.HandleReactionAdd);
    client.on('messageReactionRemove', ctx.HandleReactionRemove);
    client.on('guildMemberAdd', ctx.HandleGuildMemberAdd);
    console.log(new Date().toLocaleTimeString(), 'Ready.');
  });
  client.login(process.env.DISCORD_KEY);
}

main()
  .then(async () => await prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

//FIXME: locate memory leak
//FIXME: forward non-command messages starting with /
//TODO: auto-ban if user is blocked more than f(user) times
//TODO: report/ban feature (cached transcript)
//TODO: consume e.g. /gender male
//TODO: Gender change cooldown
//TODO: Probe for user reachability
//TODO: Message cooldown
//TODO: ranking by number of conversations
//TODO: prevent db reciprocal blocks
//TODO: don't double-welcome people who join stranger chat from the bot
