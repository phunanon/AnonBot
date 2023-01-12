import { PrismaClient, User } from '@prisma/client';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { MakeEmbed } from '.';

export function GenderSeeking({ sexFlags }: User) {
  const genderFlags = (sexFlags & 0b111000) >> 3;
  const seekFlags = sexFlags & 0b111;
  const gender = {
    0b100: 'Male' as const,
    0b010: 'Female' as const,
    0b001: 'Non-binary' as const,
  }[genderFlags];
  let seeking: ('Anyone' | 'Non-binary' | 'Female' | 'Male')[] = [];
  if (seekFlags & 0b100) seeking.push('Male');
  if (seekFlags & 0b010) seeking.push('Female');
  if (seekFlags & 0b001) seeking.push('Non-binary');
  if (seeking.length === 3) seeking = ['Anyone'];
  return { gender, seeking };
}

export function GenderButtonRows(user: User) {
  const { gender, seeking } = GenderSeeking(user);
  const seekingAnyone = seeking.includes('Anyone');
  const seekingMale = seeking.includes('Male') || seekingAnyone;
  const seekingFemale = seeking.includes('Female') || seekingAnyone;
  const seekingNonbinary = seeking.includes('Non-binary') || seekingAnyone;
  const b = (x: boolean) => (x ? ButtonStyle.Danger : ButtonStyle.Success);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('male')
        .setLabel("I'm male")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'Male'),
      new ButtonBuilder()
        .setCustomId('female')
        .setLabel("I'm female")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'Female'),
      new ButtonBuilder()
        .setCustomId('nonbinary')
        .setLabel("I'm non-binary")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(gender === 'Non-binary'),
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
    'Set your gender preferences',
    {
      colour: 'Purple',
      rows,
      fields: [
        { name: 'Your gender', inline: true, value: gender || 'Unknown' },
        { name: "You're seeking", inline: true, value: seeks },
      ],
    },
    'Press the buttons relevant to you. You can press multiple buttons.',
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
