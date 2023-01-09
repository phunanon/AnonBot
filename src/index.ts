import { PrismaClient, User } from '@prisma/client';
import { Client, IntentsBitField, CacheType, Partials } from 'discord.js';
import { Interaction, Message, PartialMessage, Typing } from 'discord.js';
import { ColorResolvable, EmbedBuilder, APIEmbedField } from 'discord.js';
import { TextBasedChannel, ChannelType, User as DUser } from 'discord.js';
import { BaseMessageOptions, ClientEvents } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder } from 'discord.js';
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
  ],
  partials: [Partials.Channel, Partials.Message],
});
const prisma = new PrismaClient();

export async function MakeEmbed(
  title: string,
  {
    colour = '#0099ff',
    fields = [],
    rows = [],
    footer,
  }: {
    colour?: ColorResolvable;
    fields?: APIEmbedField[];
    rows?: ActionRowBuilder<ButtonBuilder>[];
    footer?: boolean;
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
  return { embeds: [embed], components: rows };
}

function UserStatsEmbedFields(user: User, name: string) {
  const ls = (n: number) => n.toLocaleString();
  const numDays = Math.floor(
    (Date.now() - user.timestamp.getTime()) / 86400000,
  );
  const numDaysStr =
    numDays < 1
      ? 'today'
      : numDays < 2
      ? 'yesterday'
      : `${ls(Math.floor(numDays))} days ago`;
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
    update: { lastSeen: new Date(), tag, accessible: true },
    create: { tag, snowflake: BigInt(id) },
  });
}

async function GetUserChannel(id: number) {
  const { snowflake } = await prisma.user.findFirstOrThrow({ where: { id } });
  const member = await client.users.fetch(`${snowflake}`);
  return await member.createDM(true);
}

/** Ends user's conversation, or if not in one stops seeking for one. */
async function EndConvo(user: User) {
  if (user.convoWithId) {
    //Update partner seeking
    await prisma.user.update({
      where: { id: user.convoWithId },
      data: { convoWithId: null, seekingSince: null },
    });
    //Inform partner
    const partnerChannel = await GetUserChannel(user.convoWithId);
    if (typeof partnerChannel !== 'string') {
      await SendEmbed(
        partnerChannel,
        'Your partner left the conversation.',
        { colour: 'Red' },
        'Send a message to start a new conversation.',
      );
    }
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { convoWithId: null, seekingSince: null },
  });
}

async function JoinConvo(
  user: User,
  toJoin: User,
  greeting: Message,
  partnerChannel: TextBasedChannel,
) {
  const { id, snowflake } = user;
  const waitMin = Math.ceil(
    (new Date().getTime() - toJoin.seekingSince!.getTime()) / 1000 / 60,
  );
  const plural = waitMin === 1 ? '' : 's';
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
      `${
        name === 'them'
          ? `They waited **${waitMin} minute${plural}** for this conversation.\n`
          : ''
      }To disconnect use \`/stop\`.
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
  await prisma.user.update({
    where: { snowflake },
    data: { convoWithId: toJoin.id, ...updateData },
  });
  await prisma.user.update({
    where: { id: toJoin.id },
    data: { convoWithId: id, ...updateData },
  });
}

async function HandlePotentialCommand(
  commandName: string,
  user: User,
  reply: (message: BaseMessageOptions) => Promise<void>,
) {
  let embed: Awaited<ReturnType<typeof MakeEmbed>> | null = null;
  if (commandName === 'stop') {
    await EndConvo(user);
    if (user.convoWithId === null) {
      embed = await MakeEmbed('Okay.', { colour: 'DarkVividPink' });
    } else {
      embed = await MakeEmbed(
        'You have disconnected',
        { colour: '#ff00ff', footer: true },
        'Send a message to start a new conversation.',
      );
    }
  }
  if (commandName === 'block') {
    await EndConvo(user);
    await prisma.block.create({
      data: { blockerId: user.id, blockedId: user.convoWithId! },
    });
    embed = await MakeEmbed(
      'Disconnected and blocked',
      { colour: '#00ffff' },
      'You will never match with them again.\nSend a message to start a new conversation.',
    );
  }
  if (commandName === 'gender') {
    embed = await GenderEmbed(user);
  }
  if (embed) await reply(embed);
}

async function FindConvo(user: User, message: Message) {
  const { id, snowflake, sexFlags } = user;
  while (true) {
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
      AND (${sexFlags} & (sexFlags >> 3)) and (sexFlags & (${sexFlags} >> 3))
      ORDER BY seekingSince ASC
      LIMIT 1
    `;
    if (partner) {
      //Attempt to join a conversation (fails if partner left after seeking)
      try {
        const partnerChannel = await GetUserChannel(partner.id);
        await JoinConvo(user, partner, message, partnerChannel);
      } catch (e) {
        await prisma.user.update({
          where: { id: partner.id },
          data: {
            accessible: false,
            convoWithId: null,
            seekingSince: null,
            greeting: null,
          },
        });
        partner = undefined;
        continue;
      }
    }
    if (!partner) {
      //Start a conversation
      await prisma.user.update({
        where: { snowflake },
        data: {
          convoWithId: null,
          seekingSince: new Date(),
          greeting: message.content,
        },
      });
      await SendEmbed(
        message.channel,
        'Waiting for a partner match...',
        { footer: true },
        'Your message will be sent to them.\nTo cancel, use `/stop`.',
      );
    }
    break;
  }
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
      await prisma.user.update({
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
      //Touch user
      const user = await TouchUser(message.author);
      const { snowflake } = user;
      if (message.content.startsWith('/')) {
        const commandName = message.content.match(/^\/(\w+)/)?.[1];
        if (commandName)
          await HandlePotentialCommand(commandName, user, async x => {
            await message.reply(x);
          });
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
        await prisma.user.update({
          where: { snowflake },
          data: { convoWithId: null },
        });
        //Set partner as inaccessible
        if (user.convoWithId !== null) {
          await prisma.user.update({
            where: { id: user.convoWithId },
            data: { accessible: false, convoWithId: null },
          });
        }
        //Inform user
        await SendEmbed(
          message.channel,
          'Sorry, but your partner left the conversation.',
          { colour: '#ff0000' },
          'Send a message to start a new conversation.',
        );
      }
    },
    async HandleInteractionCreate(interaction: Interaction<CacheType>) {
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
    console.log('Ready.');
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

//TODO: Announce function
//TODO: "why not join X while you wait?"
//Release!
//TODO: Gender change cooldown
//TODO: Prevent consecutive convo with same user
//TODO: Estimated wait time
//TODO: X messages in last Y minutes (analyse msgToMsg)
//TODO: Probe for user reachability
