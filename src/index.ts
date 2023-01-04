import { PrismaClient, User } from "@prisma/client";
import { Client, IntentsBitField, CacheType, Partials } from "discord.js";
import { Interaction, Message, PartialMessage, Typing } from "discord.js";
import { ColorResolvable, EmbedBuilder, APIEmbedField } from "discord.js";
import { TextBasedChannel, ChannelType, User as DUser } from "discord.js";
import { BaseMessageOptions } from "discord.js";
import { cacheAdd, cacheHas } from "./cache";
import * as dotenv from "dotenv";
dotenv.config();

type Snowflake = string;

const client = new Client({
  intents: [
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.DirectMessageTyping,
    IntentsBitField.Flags.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message],
});
const prisma = new PrismaClient();

async function MakeEmbed(
  title: string,
  {
    colour = "#0099ff",
    fields = [],
    footer,
  }: { colour?: ColorResolvable; fields?: APIEmbedField[]; footer?: boolean },
  body?: string,
) {
  const embed = new EmbedBuilder().setColor(colour).setTitle(title);
  if (body) embed.setDescription(body);
  fields.forEach(x => embed.addFields(x));
  if (footer) {
    const numUsers = await prisma.user.count({ where: { accessible: true } });
    embed.setFooter({
      text: `${numUsers} strangers available. Made by Auekha#4109.`,
    });
  }
  return { embeds: [embed] };
}

function UserStatsEmbedFields(user: User, name: string) {
  const ls = (n: number) => n.toLocaleString();
  const numDays = Math.floor(
    (Date.now() - user.timestamp.getTime()) / 86400000,
  );
  const numDaysStr =
    numDays < 1
      ? "today"
      : numDays < 2
      ? "yesterday"
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

async function EndConvo(user: User) {
  if (user.convoWithId) {
    await prisma.user.update({
      where: { id: user.convoWithId },
      data: { convoWithId: null, seekingSince: null },
    });
    const partnerChannel = await GetUserChannel(user.convoWithId);
    if (typeof partnerChannel !== "string") {
      await SendEmbed(
        partnerChannel,
        "Your partner left the conversation.",
        { colour: "Red" },
        "Send a message to start a new conversation.",
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
  const plural = waitMin === 1 ? "" : "s";
  //Generate stats
  const yourFields = [
    UserStatsEmbedFields(user, "You"),
    UserStatsEmbedFields(toJoin, "Them"),
  ];
  const theirFields = [
    UserStatsEmbedFields(toJoin, "You"),
    UserStatsEmbedFields(user, "Them"),
  ];
  const matchEmbed = async (name: "You" | "Them") =>
    await MakeEmbed(
      "You have been matched with a partner!",
      { colour: "Green", fields: name === "You" ? yourFields : theirFields },
      `${
        name === "Them"
          ? `They waited **${waitMin} minute${plural}** for this conversation.\n`
          : ""
      }To disconnect use \`/stop\`.
To disconnect and block them, use \`/block\`.`,
    );
  //Inform users and exchange greetings
  await partnerChannel.send(await matchEmbed("You")); //This will fail in the partner left after looking for a convo
  await greeting.channel.send(await matchEmbed("Them"));
  if (toJoin.greeting) await greeting.channel.send(toJoin.greeting);
  await partnerChannel.send(
    greeting.content || "[Your partner sent no greeting text]",
  );
  //Update database
  await prisma.user.update({
    where: { snowflake },
    data: {
      convoWithId: toJoin.id,
      seekingSince: null,
      numConvo: { increment: 1 },
      numMessage: { increment: 1 },
    },
  });
  await prisma.user.update({
    where: { id: toJoin.id },
    data: {
      convoWithId: id,
      seekingSince: null,
      numConvo: { increment: 1 },
      numMessage: { increment: 1 },
    },
  });
}

async function HandlePotentialCommand(
  commandName: string,
  user: User,
  reply: (message: BaseMessageOptions) => Promise<void>,
) {
  let embed: Awaited<ReturnType<typeof MakeEmbed>> | null = null;
  if (commandName === "stop") {
    if (user.convoWithId === null) {
      embed = await MakeEmbed("You are not in a conversation.", {
        colour: "DarkVividPink",
      });
    } else {
      await EndConvo(user);
      embed = await MakeEmbed(
        "You have disconnected",
        { colour: "#ff00ff" },
        "Send a message to start a new conversation.",
      );
    }
  }
  if (commandName === "block") {
    await EndConvo(user);
    embed = await MakeEmbed(
      "Disconnected and blocked",
      { colour: "#00ffff" },
      "You will never match with them again.\nSend a message to start a new conversation.",
    );
  }
  if (embed) await reply(embed);
}

async function MakeContext() {
  //To keep track of message edits
  const msgToMsgCircBuff: [Snowflake, Snowflake][] = [];

  async function ForwardMessage(message: Message, { id, convoWithId }: User) {
    try {
      if (convoWithId === null) return "No convo";
      const partnerChannel = await GetUserChannel(convoWithId);
      const msg = await partnerChannel.send({
        content: message.content,
        embeds: message.embeds,
        files: message.attachments.map(a => a.url),
      });
      //Increment message count
      await prisma.user.update({
        where: { id },
        data: { numMessage: { increment: 1 } },
      });
      //Add both message IDs to message cache for edits and replies
      msgToMsgCircBuff.push([message.id, msg.id]);
      while (msgToMsgCircBuff.length > 2_000) {
        msgToMsgCircBuff.shift();
      }
      return true;
    } catch (e) {
      return "Partner left";
    }
  }

  return {
    async HandleMessageCreate(message: Message) {
      if (message.author.bot) return;
      if (message.channel.type !== ChannelType.DM) return;
      //Touch user
      const user = await TouchUser(message.author);
      const { snowflake } = user;
      if (message.content.startsWith("/")) {
        const commandName = message.content.match(/^\/(\w+)/)?.[1];
        if (commandName)
          await HandlePotentialCommand(commandName, user, async x => {
            await message.reply(x);
          });
        return;
      }
      //Forward messages
      const forwardResult = await ForwardMessage(message, user);
      if (forwardResult === "No convo") {
        //Start or join a conversation
        let partner = await prisma.user.findFirst({
          where: {
            accessible: true,
            convoWithId: null,
            snowflake: { not: snowflake },
            seekingSince: { not: null },
          },
        });
        if (partner) {
          //Attempt to join a conversation (fails if partner left after seeking)
          const partnerChannel = await GetUserChannel(partner.id);
          try {
            await JoinConvo(user, partner, message, partnerChannel);
          } catch (e) {
            partner = null;
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
            "Waiting for a partner match...",
            { footer: true },
            "Your message will be sent to them.\nTo cancel, use `/stop`.",
          );
        }
      }
      if (forwardResult === "Partner left") {
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
          "Sorry, but your partner left the conversation.",
          { colour: "#ff0000" },
          "Send a message to start a new conversation.",
        );
      }
    },
    async HandleInteractionCreate(interaction: Interaction<CacheType>) {
      if (!interaction.isCommand()) return;
      const { commandName, channel } = interaction;
      const user = await TouchUser(interaction.user);
      if (!channel) return;
      if (channel.type !== ChannelType.DM) {
        await interaction.reply({
          content: "Please use this command in a DM.",
          ephemeral: true,
        });
        return;
      }
      HandlePotentialCommand(commandName, user, async x => {
        await interaction.reply(x);
      });
    },
    async HandleTypingStart({ channel, user: dUser }: Typing) {
      if (cacheHas(channel.id) || dUser.bot || !dUser.tag) return;
      const user = await TouchUser(dUser);
      if (!user.convoWithId) return;
      cacheAdd(channel.id, 5_000);
      const partnerChannel = await GetUserChannel(user.convoWithId);
      if (typeof partnerChannel !== "string")
        await partnerChannel?.sendTyping();
    },
    async HandleMessageUpdate(
      oldMessage: Message<boolean> | PartialMessage,
      newMessage: Message<boolean> | PartialMessage,
    ) {
      if (oldMessage.author?.bot || oldMessage.channel.type !== ChannelType.DM)
        return;
      //TODO: Handle message edits
      newMessage.channel.send(
        "Message edits not supported yet. Your partner will still see the old message",
      );
    },
  };
}

async function main() {
  console.log("Loading.");
  client.once("ready", async () => {
    const ctx = await MakeContext();

    client.application?.commands.create({
      name: "stop",
      description: "Disconnect from partner / stop looking for a new one",
    });
    client.application?.commands.create({
      name: "block",
      description: "Disconnect and never connect to this partner again",
    });

    client.on("messageCreate", ctx.HandleMessageCreate);
    client.on("interactionCreate", ctx.HandleInteractionCreate);
    client.on("typingStart", ctx.HandleTypingStart);
    client.on("messageUpdate", ctx.HandleMessageUpdate);
    console.log("Ready.");
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

//TODO: Message guild newcomers with introduction
//TODO: Button to start new convo (with genders)
//TODO: Enforce blocks
//TODO: Handle emoji reactions
//TODO: Handle message edits
//TODO: Handle message deletes
//TODO: Probe for user reachability
//TODO: Prevent consecutive convo with same user
//TODO: Announce function
//TODO: Estimated wait time
//TODO: Gender match
