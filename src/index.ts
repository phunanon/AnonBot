const maintenanceMode = false;
const maintenanceModeMessage = `The bot is currently in maintenance mode.
Your conversation will continue as normal once work is complete.
Please try again in five minutes.`;
const mods = ['Moderator#3922', 'Auekha#4109'];
import { PrismaClient, PrismaPromise, User } from '@prisma/client';
import { Client, IntentsBitField, CacheType, Partials } from 'discord.js';
import { Interaction, Message, PartialMessage, Typing } from 'discord.js';
import { ColorResolvable, EmbedBuilder, APIEmbedField } from 'discord.js';
import { TextBasedChannel, ChannelType, User as DUser } from 'discord.js';
import { BaseMessageOptions, ClientEvents, GuildMember } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, GatewayIntentBits } from 'discord.js';
import { CommandInteraction, ButtonInteraction } from 'discord.js';
import { ChangeGender, GenderEmbed, GenderSeeking } from './gender';
import { cacheAdd, cacheHas } from './cache';
import * as dotenv from 'dotenv';
dotenv.config();

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
const historicalWaitTimes: number[] = [];
let newConvoSemaphore = false;

async function resilience<T>(f: () => Promise<T>) {
  for (let i = 0; i < 5; i++) {
    try {
      return await f();
    } catch (e) {
      console.log(i, 'resilience', e);
    }
  }
  //TODO: throw and inform user
}

const transaction = async (...actions: PrismaPromise<any>[]) =>
  await resilience(async () => await prisma.$transaction(actions));

const userUpdate = async (
  params: Parameters<typeof prisma['user']['update']>[0],
) => resilience(() => prisma.user.update(params));

export async function MakeEmbed(
  title: string,
  {
    colour = '#0099ff',
    fields = [],
    rows = [],
    footer,
    content,
  }: {
    colour?: ColorResolvable;
    fields?: APIEmbedField[];
    rows?: ActionRowBuilder<ButtonBuilder>[];
    footer?: boolean;
    content?: string;
  },
  body?: string,
) {
  const embed = new EmbedBuilder().setColor(colour).setTitle(title);
  if (body) embed.setDescription(body);
  fields.forEach(x => embed.addFields(x));
  if (footer) {
    const numUser = (
      await prisma.user.count({ where: { accessible: true } })
    ).toLocaleString();
    const numConvo = (
      await prisma.user.aggregate({ _sum: { numConvo: true } })
    )._sum.numConvo!.toLocaleString();
    const numMessage = (
      await prisma.user.aggregate({ _sum: { numMessage: true } })
    )._sum.numMessage!.toLocaleString();
    embed.setFooter({
      text: `${numUser} strangers; ${numConvo} convos, ${numMessage} messages ever.`,
    });
  }
  return { embeds: [embed], components: rows, content };
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

async function SendEmbed(
  channel: TextBasedChannel,
  ...args: Parameters<typeof MakeEmbed>
) {
  return await channel.send(await MakeEmbed(...args));
}

async function TouchUser({ id, tag }: DUser) {
  return await prisma.user.upsert({
    where: { snowflake: BigInt(id) },
    update: { lastSeenAt: new Date().getTime(), tag, accessible: true },
    create: { createdAt: new Date().getTime(), tag, snowflake: BigInt(id) },
  });
}

async function GetUserChannel(id: number) {
  const { snowflake } = await prisma.user.findFirstOrThrow({ where: { id } });
  const member = await client.users.fetch(`${snowflake}`);
  return await member.createDM(true);
}

/** Ends user's conversation, or if not in one stops seeking for one. */
async function EndConvo(user: User, partnerInaccessible?: boolean) {
  console.log(Date.now(), 'EndConvo ', user.tag);
  if (user.convoWithId) {
    //Update partners
    const data = { convoWithId: null, seekingSince: null };
    await transaction(
      prisma.user.update({ where: { id: user.id }, data }),
      prisma.user.update({ where: { id: user.convoWithId }, data }),
    );
    //Inform partner / mark them as inaccessible
    if (partnerInaccessible) {
      await MarkInaccessible(user.convoWithId);
    } else {
      try {
        const partnerChannel = await GetUserChannel(user.convoWithId);
        await SendEmbed(
          partnerChannel,
          'Your partner left the conversation.',
          { colour: 'Red' },
          'Send a message to start a new conversation.',
        );
      } catch (e) {
        await MarkInaccessible(user.convoWithId);
      }
    }
    return user.convoWithId;
  } else {
    //Stop seeking
    const data = { seekingSince: null, greeting: null };
    await userUpdate({ where: { id: user.id }, data });
  }
}

const Minutes = (min: number) =>
  min === 1 ? 'less than a minute' : `${min} minutes`;

async function JoinConvo(
  user: User,
  toJoin: User,
  greeting: Message,
  partnerChannel: TextBasedChannel,
) {
  console.log(Date.now(), 'JoinConvo', user.tag, toJoin.tag);
  const { id, snowflake } = user;
  let waitMin: number | string = Math.ceil(
    (new Date().getTime() - toJoin.seekingSince!.getTime()) / 1000 / 60,
  );
  historicalWaitTimes.push(waitMin);
  if (historicalWaitTimes.length > 64) historicalWaitTimes.shift();
  waitMin = Minutes(waitMin);
  //Generate stats
  const { gender: youGender, seeking: youSeeking } = GenderSeeking(user);
  const { gender: themGender, seeking: themSeeking } = GenderSeeking(toJoin);
  const seeking = (name: string, seeking: string[], gender?: string) =>
    `${name} – ${gender ? `${gender} ` : ''}seeking ${seeking.join(' + ')}`;
  const yourFields = [
    UserStatsEmbedFields(user, seeking('You', youSeeking, youGender)),
    UserStatsEmbedFields(toJoin, seeking('Them', themSeeking, themGender)),
  ];
  const theirFields = [
    UserStatsEmbedFields(toJoin, seeking('You', themSeeking, themGender)),
    UserStatsEmbedFields(user, seeking('Them', youSeeking, youGender)),
  ];
  const matchEmbed = async (name: 'you' | 'them') =>
    await MakeEmbed(
      'You have been matched with a partner!',
      { colour: 'Green', fields: name === 'you' ? yourFields : theirFields },
      `It took **${waitMin}** for this match to be found.
To disconnect use \`/stop\`.
To disconnect and block them, use \`/block\`.
To match particular genders, use \`/gender\`.`,
    );
  //Inform users and exchange greetings
  //(This partner send will throw if the partner left after looking for a convo)
  await partnerChannel.send(await matchEmbed('them'));
  await greeting.channel.send(await matchEmbed('you'));
  if (toJoin.greeting) await greeting.channel.send(toJoin.greeting);
  await partnerChannel.send(
    greeting.content || '[Your partner sent no greeting text]',
  );
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
      data: { convoWithId: toJoin.id, prevWithId: toJoin.id, ...updateData },
    }),
    prisma.user.update({
      where: { id: toJoin.id },
      data: { convoWithId: id, prevWithId: user.id, ...updateData },
    }),
  );
}

async function HandlePotentialCommand(
  commandName: string,
  user: User,
  reply: (message: BaseMessageOptions) => Promise<void>,
  arg?: string,
) {
  let embed: Awaited<ReturnType<typeof MakeEmbed>> | null = null;
  if (commandName === 'stop') {
    const wasInConvo = await EndConvo(user);
    embed = await MakeEmbed(
      wasInConvo
        ? 'You have disconnected'
        : user.seekingSince
        ? 'You are no longer seeking'
        : "You aren't in a conversation",
      { colour: '#ff00ff', footer: true },
      'Send a message to start a new conversation.',
    );
  }
  if (commandName === 'block') {
    console.log('Blocker', user.tag);
    const wasInConvoWith = await EndConvo(user);
    if (wasInConvoWith) {
      await prisma.block.create({
        data: { blockerId: user.id, blockedId: wasInConvoWith },
      });
      embed = await MakeEmbed(
        'Disconnected and blocked',
        { colour: '#00ffff' },
        'You will never match with them again.\nSend a message to start a new conversation.',
      );
    } else {
      embed = await MakeEmbed(
        'You are not in a conversation.',
        { colour: 'Red' },
        'Send a message to start a new conversation.',
      );
    }
  }
  if (commandName === 'gender') {
    embed = await GenderEmbed(user);
  }
  if (commandName === 'ban' && user.tag === 'Moderator#3922') {
    const wasInConvoWith = await EndConvo(user);
    if (wasInConvoWith) {
      await MarkInaccessible(wasInConvoWith, true);
      embed = await MakeEmbed('Done.', { colour: 'Green' });
    }
  }
  if (embed) await reply(embed);
}

async function MarkInaccessible(id: number, banned?: boolean) {
  const data = {
    accessible: false,
    convoWithId: null,
    seekingSince: null,
    greeting: null,
    banned,
  };
  await userUpdate({ where: { id }, data });
}

function EstWaitMessage() {
  if (!historicalWaitTimes.length) return '';
  //Median of historical wait times
  const estWait = historicalWaitTimes.sort((a, b) => a - b)[
    Math.floor(historicalWaitTimes.length / 2)
  ]!;
  return `Estimated wait time: **${Minutes(estWait)}**.
`;
}

async function FindConvo(user: User, message: Message) {
  while (newConvoSemaphore) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  newConvoSemaphore = true;
  const { id, snowflake, sexFlags } = user;
  while (true) {
    //TODO: prevent consecutives: AND prevWithId != ${id}
    let [partner] = await prisma.$queryRaw<User[]>`
      SELECT * FROM "User"
      WHERE accessible = true
      AND convoWithId IS NULL
      AND snowflake != ${snowflake}
      AND seekingSince IS NOT NULL
      AND NOT EXISTS (
        SELECT * FROM "Block"
        WHERE blockerId = ${id} AND blockedId = "User".id
      )
      AND NOT EXISTS (
        SELECT * FROM "Block"
        WHERE blockerId = "User".id AND blockedId = ${id}
      )
      AND ((${sexFlags} & 7) & (sexFlags >> 3)) AND NOT (~(${sexFlags} & 7) & (sexFlags >> 3))
      AND ((sexFlags & 7) & (${sexFlags} >> 3)) AND NOT (~(sexFlags & 7) & (${sexFlags} >> 3))
      ORDER BY seekingSince ASC
      LIMIT 1
    `;
    if (partner) {
      //Attempt to join a conversation (fails if partner left after seeking)
      try {
        const partnerChannel = await GetUserChannel(partner.id);
        await JoinConvo(user, partner, message, partnerChannel);
      } catch (e) {
        console.log('JoinConvoFail', user.tag, partner.tag, e);
        await MarkInaccessible(partner.id);
        continue;
      }
    }
    if (!partner) {
      //Start seeking
      await userUpdate({
        where: { snowflake },
        data: {
          convoWithId: null,
          seekingSince: new Date(),
          greeting: message.content,
        },
      });
      const estWaitMessage = EstWaitMessage();
      await SendEmbed(
        message.channel,
        'Waiting for a partner match...',
        { footer: true },
        `${estWaitMessage}Your message will be sent to them.
To cancel, use \`/stop\`.`,
      );
    }
    break;
  }
  newConvoSemaphore = false;
}

async function HandleCommandInteraction(interaction: CommandInteraction) {
  const { commandName, channel } = interaction;
  const user = await TouchUser(interaction.user);
  if (!channel) return;
  if (channel.type !== ChannelType.DM) {
    await interaction.reply({
      content: 'Please use this command in a DM.',
      ephemeral: true,
    });
    return;
  }
  await HandlePotentialCommand(commandName, user, async x => {
    await interaction.reply(x);
  });
}

async function HandleButtonInteraction(interaction: ButtonInteraction) {
  const { customId } = interaction;
  const user = await TouchUser(interaction.user);
  await ChangeGender(prisma, user, customId);
  await interaction.update(await GenderEmbed(user));
}

async function MakeContext() {
  //Circular buffer to keep track of message edits
  const msgToMsg: { a: Message; b: Message }[] = [];

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

  async function ForwardMessage(message: Message, { id, convoWithId }: User) {
    try {
      if (convoWithId === null) return 'No convo';
      const partnerChannel = await GetUserChannel(convoWithId);
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
      return true;
    } catch (e) {
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
      if (user.banned) {
        await message.reply('You are banned from using this bot.');
        return;
      }
      if (/^(\/|!)/.test(message.content)) {
        const [_, commandName, arg] =
          message.content.trim().match(/^(?:\/|!)(\w+)(?:\s([\s\S]+))?/) ?? [];
        const reply = async (x: BaseMessageOptions) => {
          await message.reply(x);
        };
        if (commandName)
          await HandlePotentialCommand(commandName, user, reply, arg);
        return;
      }
      //Forward messages
      const forwardResult = await ForwardMessage(message, user);
      if (forwardResult === 'No convo') {
        //Start or join a conversation
        await FindConvo(user, message);
      }
      if (forwardResult === 'Partner left') {
        //End conversation
        await EndConvo(user);
        //Inform user
        await SendEmbed(
          message.channel,
          'Sorry, but your partner left the conversation.',
          { colour: '#ff4444' },
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
      if (!user.convoWithId) return;
      cacheAdd(channel.id, 5_000);
      const partnerChannel = await GetUserChannel(user.convoWithId);
      if (typeof partnerChannel !== 'string')
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
      await partnerMessage.react(emoji);
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
      console.log(
        new Date().toLocaleTimeString(),
        'guildMemberAdd',
        member.user.tag,
      );
      const embed = (withBlockWarning: boolean) =>
        [
          'Welcome!',
          { colour: '#00ff00', content: `<@${member.id}>` },
          `I'm a bot that connects you to random people in DMs. Send me a message to start a conversation.${
            withBlockWarning
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
          '971115937258430506': '1062131286296248411',
        }[member.guild.id];
        if (!sf) return;
        const welcomeChannel = await member.guild.channels.fetch(sf);
        if (!welcomeChannel?.isTextBased()) return;
        await SendEmbed(welcomeChannel, ...embed(true));
      }
      await TouchUser(member.user);
    },
  };
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

//TODO: prevent mass join-leave sprees
//TODO: report feature
//TODO: ban feature
//TODO: "why not join X while you wait?"
//TODO: consume e.g. /gender male
//TODO: Gender change cooldown
//TODO: Probe for user reachability
//TODO: Message cooldown
//TODO: make SendEmbed mark as inaccessible, rather than all over the place
//TODO: convos in last 24h
