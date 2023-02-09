import { PrismaClient, User } from '@prisma/client';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { MakeEmbed } from '.';

export function GenderSeeking({ sexFlags }: User) {
  const genderFlags = (sexFlags & 0b111000) >> 3;
  const seekFlags = sexFlags & 0b111;
  const gender = {
    0b100: 'male' as const,
    0b010: 'female' as const,
    0b001: 'non-binary' as const,
  }[genderFlags];
  let seeking: ('anyone' | 'non-binary' | 'female' | 'male')[] = [];
  if (seekFlags & 0b100) seeking.push('male');
  if (seekFlags & 0b010) seeking.push('female');
  if (seekFlags & 0b001) seeking.push('non-binary');
  if (seeking.length === 3) seeking = ['anyone'];
  return { gender, seeking };
}

export function GenderButtonRows(user: User) {
  const { gender, seeking } = GenderSeeking(user);
  const seekingAnyone = seeking.includes('anyone');
  const seekingMale = seeking.includes('male') || seekingAnyone;
  const seekingFemale = seeking.includes('female') || seekingAnyone;
  const seekingNonbinary = seeking.includes('non-binary') || seekingAnyone;
  const b = (x: boolean) => (x ? ButtonStyle.Danger : ButtonStyle.Success);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('male')
        .setLabel("I'm male")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'male'),
      new ButtonBuilder()
        .setCustomId('female')
        .setLabel("I'm female")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'female'),
      new ButtonBuilder()
        .setCustomId('nonbinary')
        .setLabel("I'm non-binary")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'non-binary'),
      new ButtonBuilder()
        .setCustomId('nosay')
        .setLabel("I'd rather not say")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!gender),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('seekingMale')
        .setLabel(`${seekingMale ? 'Stop' : 'Start'} seeking male`)
        .setStyle(b(seekingMale)),
      new ButtonBuilder()
        .setCustomId('seekingFemale')
        .setLabel(`${seekingFemale ? 'Stop' : 'Start'} seeking female`)
        .setStyle(b(seekingFemale)),
      new ButtonBuilder()
        .setCustomId('seekingNonbinary')
        .setLabel(`${seekingNonbinary ? 'Stop' : 'Start'} seeking non-binary`)
        .setStyle(b(seekingNonbinary)),
    ),
  ];
}

export async function GenderEmbed(user: User) {
  const rows = GenderButtonRows(user);
  const { gender, seeking } = GenderSeeking(user);
  const seeks = seeking.join(' + ');
  return await MakeEmbed(
    'Set your gender preferences.',
    {
      colour: 'Purple',
      rows,
      fields: [
        { name: 'Your gender', inline: true, value: gender || 'Unknown' },
        { name: "You're seeking", inline: true, value: seeks },
      ],
    },
    `Press the buttons relevant to you. You can press multiple buttons.
⚠️ Matching specific genders greatly increases wait time for a new conversation. For quicker matching, match with anyone.`,
  );
}

export async function ChangeGender(
  prisma: PrismaClient,
  user: User,
  command: string,
) {
  const gender = (user.sexFlags & 0b111000) >> 3;
  const seeking = user.sexFlags & 0b111;

  const newGender =
    {
      male: 0b100 as const,
      female: 0b010 as const,
      nonbinary: 0b001 as const,
      seekingMale: gender,
      seekingFemale: gender,
      seekingNonbinary: gender,
    }[command] || 0;

  const newSeeking =
    {
      seekingMale: 0b100 as const,
      seekingFemale: 0b010 as const,
      seekingNonbinary: 0b001 as const,
    }[command] || 0;

  let sexFlags = (newGender << 3) | (seeking ^ newSeeking);
  if (!(sexFlags & 0b111)) sexFlags |= 0b111; //If seeking none, seek all
  if (!(sexFlags & 0b111000)) sexFlags |= 0b111000; //If no gender, all genders

  user.sexFlags = sexFlags;

  await prisma.user.update({
    where: { id: user.id },
    data: { sexFlags, sexChanged: new Date().getTime() },
  });
}
