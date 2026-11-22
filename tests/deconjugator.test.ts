import { describe, expect, it } from 'vitest';
import { deconjugate } from '../src/core/deconjugator';

describe('deconjugate', () => {
  it('deconjugates ichidan progressive and polite forms', () => {
    expect(deconjugate('食べていた')).toContain('食べる');
    expect(deconjugate('食べます')).toContain('食べる');
    expect(deconjugate('見なかった')).toContain('見る');
  });

  it('deconjugates godan polite, negative, and past forms', () => {
    expect(deconjugate('飲みます')).toContain('飲む');
    expect(deconjugate('行かない')).toContain('行く');
    expect(deconjugate('話した')).toContain('話す');
    expect(deconjugate('稼いだ')).toContain('稼ぐ');
    expect(deconjugate('泳いで')).toContain('泳ぐ');
  });

  it('deconjugates i-adjectives', () => {
    expect(deconjugate('美味しかった')).toContain('美味しい');
    expect(deconjugate('楽しくない')).toContain('楽しい');
  });

  it('deconjugates suru compounds and irregular verbs', () => {
    expect(deconjugate('勉強している')).toContain('勉強する');
    expect(deconjugate('勉強している')).toContain('勉強');
    expect(deconjugate('行って')).toContain('行く');
    expect(deconjugate('来た')).toContain('来る');
  });

  it('deconjugates multi-step chained conjugations like 飽きられたら and 食べさせられた', () => {
    expect(deconjugate('飽きられたら')).toContain('飽きる');
    expect(deconjugate('食べさせられた')).toContain('食べる');
    expect(deconjugate('言われていたら')).toContain('言う');
    expect(deconjugate('見られたくなかった')).toContain('見る');
    expect(deconjugate('さらっちまおう')).toContain('さらう');
    expect(deconjugate('やっちまった')).toContain('やる');
    expect(deconjugate('死んじまった')).toContain('死ぬ');
    expect(deconjugate('行っちゃおう')).toContain('行く');
    expect(deconjugate('引き落とせる')).toContain('引き落とす');
    expect(deconjugate('引き落とせねえ')).toContain('引き落とす');
    expect(deconjugate('勝てねえ')).toContain('勝つ');
    expect(deconjugate('知らねえ')).toContain('知る');
  });
});
