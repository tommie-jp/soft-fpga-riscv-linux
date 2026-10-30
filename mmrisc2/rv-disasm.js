'use strict';
// rv-disasm.js — RISC-V (RV64GC) の命令を 1 つ文字にする (Logic Analyzer のデコードレーンと書式に使う)
//
//   RVDIS.disasm(insn, pc)   'ld a0,8(sp)' のような文字。pc を渡すと分岐の行き先を番地で書く
//   RVDIS.mnemonic(insn)     'ld' だけ
//   RVDIS.cls(insn)          命令の種類 ('load' 'store' 'branch' 'jump' 'alu' 'muldiv' 'csr' 'system'
//                            'amo' 'fp' 'fence' 'illegal')。デコードレーンの色に使う
//   RVDIS.ABI[n]             x レジスタの ABI 名 (zero ra sp ...)
//   RVDIS.csrName(n)         CSR の名前 (知らない番号は 16 進)
//
// 対象: RV64IMAFDC、Zicsr、Zifencei、Zba・Zbb・Zbc・Zbs、Zicboz、特権命令 (mret・sret・wfi・sfence.vma)。
// 圧縮命令 (下 2 ビットが 11 でない) は 32 ビットの命令に伸ばしてから読む (コアの CORE_DECOMP と同じ順)。
// 書き方は GNU objdump に寄せた (別名 li・mv・ret・j・nop・beqz・csrr などを使う)。
(function () {
  var ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
  var FABI = ['ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'fs0', 'fs1', 'fa0', 'fa1', 'fa2', 'fa3',
    'fa4', 'fa5', 'fa6', 'fa7', 'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11',
    'ft8', 'ft9', 'ft10', 'ft11'];
  var CSR = {
    0x001: 'fflags', 0x002: 'frm', 0x003: 'fcsr',
    0x100: 'sstatus', 0x104: 'sie', 0x105: 'stvec', 0x106: 'scounteren', 0x10a: 'senvcfg',
    0x140: 'sscratch', 0x141: 'sepc', 0x142: 'scause', 0x143: 'stval', 0x144: 'sip', 0x14d: 'stimecmp',
    0x180: 'satp',
    0x300: 'mstatus', 0x301: 'misa', 0x302: 'medeleg', 0x303: 'mideleg', 0x304: 'mie', 0x305: 'mtvec',
    0x306: 'mcounteren', 0x30a: 'menvcfg', 0x320: 'mcountinhibit',
    0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval', 0x344: 'mip',
    0x3a0: 'pmpcfg0', 0x3a2: 'pmpcfg2', 0x3b0: 'pmpaddr0',
    0x7a0: 'tselect', 0x7a1: 'tdata1', 0x7a2: 'tdata2', 0x7b0: 'dcsr', 0x7b1: 'dpc',
    0xb00: 'mcycle', 0xb02: 'minstret', 0xc00: 'cycle', 0xc01: 'time', 0xc02: 'instret',
    0xf11: 'mvendorid', 0xf12: 'marchid', 0xf13: 'mimpid', 0xf14: 'mhartid'
  };

  function hex(v) { return '0x' + (v >>> 0).toString(16); }
  function sext(v, bits) { var s = 32 - bits; return (v << s) >> s; }
  function x(n) { return ABI[n]; }
  function f(n) { return FABI[n]; }
  function csrName(n) { return CSR[n] || hex(n); }
  function bits(v, hi, lo) { return (v >>> lo) & ((1 << (hi - lo + 1)) - 1); }

  // ---- 32 ビットの命令を組む (圧縮命令を伸ばすため) ----
  function encR(op, rd, f3, rs1, rs2, f7) { return (f7 << 25 | rs2 << 20 | rs1 << 15 | f3 << 12 | rd << 7 | op) >>> 0; }
  function encI(op, rd, f3, rs1, imm) { return ((imm & 0xfff) << 20 | rs1 << 15 | f3 << 12 | rd << 7 | op) >>> 0; }
  function encS(op, f3, rs1, rs2, imm) {
    return (bits(imm, 11, 5) << 25 | rs2 << 20 | rs1 << 15 | f3 << 12 | bits(imm, 4, 0) << 7 | op) >>> 0;
  }
  function encB(f3, rs1, rs2, imm) {
    return (bits(imm, 12, 12) << 31 | bits(imm, 10, 5) << 25 | rs2 << 20 | rs1 << 15 | f3 << 12 |
            bits(imm, 4, 1) << 8 | bits(imm, 11, 11) << 7 | 0x63) >>> 0;
  }
  function encU(op, rd, imm20) { return ((imm20 & 0xfffff) << 12 | rd << 7 | op) >>> 0; }
  function encJ(rd, imm) {
    return (bits(imm, 20, 20) << 31 | bits(imm, 10, 1) << 21 | bits(imm, 11, 11) << 20 |
            bits(imm, 19, 12) << 12 | rd << 7 | 0x6f) >>> 0;
  }

  // 圧縮命令を 32 ビットの命令に伸ばす。読めない物は 0 (不正な命令)
  function expand(c) {
    var q = c & 3, f3 = bits(c, 15, 13);
    var rd = bits(c, 11, 7), rs2 = bits(c, 6, 2);
    var rdp = 8 + bits(c, 4, 2), rs1p = 8 + bits(c, 9, 7);
    var imm6 = sext(bits(c, 12, 12) << 5 | bits(c, 6, 2), 6);
    if (c === 0) return 0;
    if (q === 0) {
      var uw = bits(c, 12, 10) << 3 | bits(c, 6, 6) << 2 | bits(c, 5, 5) << 6;   // lw / sw
      var ud = bits(c, 12, 10) << 3 | bits(c, 6, 5) << 6;                       // ld / sd / fld / fsd
      switch (f3) {
        case 0: {
          var nz = bits(c, 12, 11) << 4 | bits(c, 10, 7) << 6 | bits(c, 6, 6) << 2 | bits(c, 5, 5) << 3;
          return nz ? encI(0x13, rdp, 0, 2, nz) : 0;
        }
        case 1: return encI(0x07, rdp, 3, rs1p, ud);
        case 2: return encI(0x03, rdp, 2, rs1p, uw);
        case 3: return encI(0x03, rdp, 3, rs1p, ud);
        case 5: return encS(0x27, 3, rs1p, rdp, ud);
        case 6: return encS(0x23, 2, rs1p, rdp, uw);
        case 7: return encS(0x23, 3, rs1p, rdp, ud);
      }
      return 0;
    }
    if (q === 1) {
      switch (f3) {
        case 0: return encI(0x13, rd, 0, rd, imm6);
        case 1: return rd ? encI(0x1b, rd, 0, rd, imm6) : 0;
        case 2: return encI(0x13, rd, 0, 0, imm6);
        case 3:
          if (rd === 2) {
            var sp = sext(bits(c, 12, 12) << 9 | bits(c, 6, 6) << 4 | bits(c, 5, 5) << 6 |
                          bits(c, 4, 3) << 7 | bits(c, 2, 2) << 5, 10);
            return sp ? encI(0x13, 2, 0, 2, sp) : 0;
          }
          return imm6 ? encU(0x37, rd, imm6) : 0;
        case 4: {
          var sh = bits(c, 12, 12) << 5 | bits(c, 6, 2);
          switch (bits(c, 11, 10)) {
            case 0: return encI(0x13, rs1p, 5, rs1p, sh);
            case 1: return encI(0x13, rs1p, 5, rs1p, 0x400 | sh);
            case 2: return encI(0x13, rs1p, 7, rs1p, imm6);
          }
          var r2 = rdp, k = bits(c, 6, 5);
          if (bits(c, 12, 12) === 0) {
            return [encR(0x33, rs1p, 0, rs1p, r2, 0x20), encR(0x33, rs1p, 4, rs1p, r2, 0),
                    encR(0x33, rs1p, 6, rs1p, r2, 0), encR(0x33, rs1p, 7, rs1p, r2, 0)][k];
          }
          if (k === 0) return encR(0x3b, rs1p, 0, rs1p, r2, 0x20);
          if (k === 1) return encR(0x3b, rs1p, 0, rs1p, r2, 0);
          return 0;
        }
        case 5: {
          var j = sext(bits(c, 12, 12) << 11 | bits(c, 11, 11) << 4 | bits(c, 10, 9) << 8 | bits(c, 8, 8) << 10 |
                       bits(c, 7, 7) << 6 | bits(c, 6, 6) << 7 | bits(c, 5, 3) << 1 | bits(c, 2, 2) << 5, 12);
          return encJ(0, j);
        }
        case 6: case 7: {
          var b = sext(bits(c, 12, 12) << 8 | bits(c, 11, 10) << 3 | bits(c, 6, 5) << 6 |
                       bits(c, 4, 3) << 1 | bits(c, 2, 2) << 5, 9);
          return encB(f3 === 6 ? 0 : 1, rs1p, 0, b);
        }
      }
      return 0;
    }
    if (q === 2) {
      switch (f3) {
        case 0: return encI(0x13, rd, 1, rd, bits(c, 12, 12) << 5 | bits(c, 6, 2));
        case 1: return encI(0x07, rd, 3, 2, bits(c, 12, 12) << 5 | bits(c, 6, 5) << 3 | bits(c, 4, 2) << 6);
        case 2: return rd ? encI(0x03, rd, 2, 2, bits(c, 12, 12) << 5 | bits(c, 6, 4) << 2 | bits(c, 3, 2) << 6) : 0;
        case 3: return rd ? encI(0x03, rd, 3, 2, bits(c, 12, 12) << 5 | bits(c, 6, 5) << 3 | bits(c, 4, 2) << 6) : 0;
        case 4:
          if (bits(c, 12, 12) === 0) {
            if (rs2 === 0) return rd ? encI(0x67, 0, 0, rd, 0) : 0;
            return encR(0x33, rd, 0, 0, rs2, 0);
          }
          if (rs2 === 0) return rd ? encI(0x67, 1, 0, rd, 0) : 0x00100073;
          return encR(0x33, rd, 0, rd, rs2, 0);
        case 5: return encS(0x27, 3, 2, rs2, bits(c, 12, 10) << 3 | bits(c, 9, 7) << 6);
        case 6: return encS(0x23, 2, 2, rs2, bits(c, 12, 9) << 2 | bits(c, 8, 7) << 6);
        case 7: return encS(0x23, 3, 2, rs2, bits(c, 12, 10) << 3 | bits(c, 9, 7) << 6);
      }
    }
    return 0;
  }

  // ---- 32 ビットの命令を読む。{ m: 名前, a: オペランドの文字, c: 種類 } ----
  function dec(i, pc) {
    var op = i & 0x7f, rd = bits(i, 11, 7), f3 = bits(i, 14, 12), rs1 = bits(i, 19, 15), rs2 = bits(i, 24, 20);
    var f7 = bits(i, 31, 25);
    var immI = i >> 20;
    var immS = (i >> 25) << 5 | bits(i, 11, 7);
    var immB = sext(bits(i, 31, 31) << 12 | bits(i, 7, 7) << 11 | bits(i, 30, 25) << 5 | bits(i, 11, 8) << 1, 13);
    var immJ = sext(bits(i, 31, 31) << 20 | bits(i, 19, 12) << 12 | bits(i, 20, 20) << 11 | bits(i, 30, 21) << 1, 21);
    var tgt = function (off) { return pc === undefined ? String(off) : hex(pc + off); };
    var R = function (m, c) { return { m: m, a: x(rd) + ',' + x(rs1) + ',' + x(rs2), c: c || 'alu' }; };
    var I = function (m, v) { return { m: m, a: x(rd) + ',' + x(rs1) + ',' + v, c: 'alu' }; };
    switch (op) {
      case 0x37: return { m: 'lui', a: x(rd) + ',' + hex(i >>> 12), c: 'alu' };
      case 0x17: return { m: 'auipc', a: x(rd) + ',' + hex(i >>> 12), c: 'alu' };
      case 0x6f:
        if (rd === 0) return { m: 'j', a: tgt(immJ), c: 'jump' };
        return { m: 'jal', a: (rd === 1 ? '' : x(rd) + ',') + tgt(immJ), c: 'jump' };
      case 0x67:
        if (f3 !== 0) break;
        if (rd === 0 && rs1 === 1 && immI === 0) return { m: 'ret', a: '', c: 'jump' };
        if (rd === 0 && immI === 0) return { m: 'jr', a: x(rs1), c: 'jump' };
        if (rd === 1 && immI === 0) return { m: 'jalr', a: x(rs1), c: 'jump' };
        return { m: 'jalr', a: x(rd) + ',' + immI + '(' + x(rs1) + ')', c: 'jump' };
      case 0x63: {
        var bn = ['beq', 'bne', '', '', 'blt', 'bge', 'bltu', 'bgeu'][f3];
        if (!bn) break;
        if (rs2 === 0 && f3 <= 5) return { m: bn + 'z', a: x(rs1) + ',' + tgt(immB), c: 'branch' };
        if (rs1 === 0 && (f3 === 4 || f3 === 5)) return { m: f3 === 4 ? 'bgtz' : 'blez', a: x(rs2) + ',' + tgt(immB), c: 'branch' };
        return { m: bn, a: x(rs1) + ',' + x(rs2) + ',' + tgt(immB), c: 'branch' };
      }
      case 0x03: {
        var ln = ['lb', 'lh', 'lw', 'ld', 'lbu', 'lhu', 'lwu', ''][f3];
        if (!ln) break;
        return { m: ln, a: x(rd) + ',' + immI + '(' + x(rs1) + ')', c: 'load' };
      }
      case 0x23: {
        var sn = ['sb', 'sh', 'sw', 'sd'][f3];
        if (!sn) break;
        return { m: sn, a: x(rs2) + ',' + immS + '(' + x(rs1) + ')', c: 'store' };
      }
      case 0x07:
        if (f3 === 2 || f3 === 3) return { m: f3 === 2 ? 'flw' : 'fld', a: f(rd) + ',' + immI + '(' + x(rs1) + ')', c: 'load' };
        break;
      case 0x27:
        if (f3 === 2 || f3 === 3) return { m: f3 === 2 ? 'fsw' : 'fsd', a: f(rs2) + ',' + immS + '(' + x(rs1) + ')', c: 'store' };
        break;
      case 0x13: {
        var sh6 = bits(i, 25, 20), f6 = bits(i, 31, 26);
        switch (f3) {
          case 0:
            if (i === 0x13) return { m: 'nop', a: '', c: 'alu' };
            if (rs1 === 0) return { m: 'li', a: x(rd) + ',' + immI, c: 'alu' };
            if (immI === 0) return { m: 'mv', a: x(rd) + ',' + x(rs1), c: 'alu' };
            return I('addi', immI);
          case 2: return I('slti', immI);
          case 3: return immI === 1 ? { m: 'seqz', a: x(rd) + ',' + x(rs1), c: 'alu' } : I('sltiu', immI);
          case 4: return immI === -1 ? { m: 'not', a: x(rd) + ',' + x(rs1), c: 'alu' } : I('xori', immI);
          case 6: return I('ori', immI);
          case 7: return I('andi', immI);
          case 1:
            if (f6 === 0) return I('slli', sh6);
            if (f6 === 0x0a) return I('bseti', sh6);
            if (f6 === 0x12) return I('bclri', sh6);
            if (f6 === 0x1a) return I('binvi', sh6);
            if (f7 === 0x30) {
              var un = { 0: 'clz', 1: 'ctz', 2: 'cpop', 4: 'sext.b', 5: 'sext.h' }[rs2];
              if (un) return { m: un, a: x(rd) + ',' + x(rs1), c: 'alu' };
            }
            break;
          case 5:
            if (f6 === 0) return I('srli', sh6);
            if (f6 === 0x10) return I('srai', sh6);
            if (f6 === 0x18) return I('rori', sh6);
            if (f6 === 0x12) return I('bexti', sh6);
            if ((immI & 0xfff) === 0x287) return { m: 'orc.b', a: x(rd) + ',' + x(rs1), c: 'alu' };
            if ((immI & 0xfff) === 0x6b8) return { m: 'rev8', a: x(rd) + ',' + x(rs1), c: 'alu' };
            break;
        }
        break;
      }
      case 0x1b:
        if (f3 === 0) return immI === 0 ? { m: 'sext.w', a: x(rd) + ',' + x(rs1), c: 'alu' } : I('addiw', immI);
        if (f3 === 1 && f7 === 0) return I('slliw', rs2);
        if (f3 === 1 && bits(i, 31, 26) === 0x02) return I('slli.uw', bits(i, 25, 20));
        if (f3 === 1 && f7 === 0x30) {
          var uw = { 0: 'clzw', 1: 'ctzw', 2: 'cpopw' }[rs2];
          if (uw) return { m: uw, a: x(rd) + ',' + x(rs1), c: 'alu' };
        }
        if (f3 === 5 && f7 === 0) return I('srliw', rs2);
        if (f3 === 5 && f7 === 0x20) return I('sraiw', rs2);
        if (f3 === 5 && f7 === 0x30) return I('roriw', rs2);
        break;
      case 0x33: {
        var key = f7 << 3 | f3;
        var n33 = {
          0x000: 'add', 0x100: 'sub', 0x001: 'sll', 0x002: 'slt', 0x003: 'sltu', 0x004: 'xor', 0x005: 'srl',
          0x105: 'sra', 0x006: 'or', 0x007: 'and',
          0x082: 'sh1add', 0x084: 'sh2add', 0x086: 'sh3add',
          0x107: 'andn', 0x106: 'orn', 0x104: 'xnor', 0x02c: 'min', 0x02e: 'max', 0x02d: 'minu', 0x02f: 'maxu',
          0x181: 'rol', 0x185: 'ror', 0x029: 'clmul', 0x02a: 'clmulr', 0x02b: 'clmulh',
          0x0a1: 'bset', 0x121: 'bclr', 0x1a1: 'binv', 0x125: 'bext'
        };
        if (f7 === 1) return R(['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'][f3], 'muldiv');
        if (key === 0x000 && rs1 === 0) return { m: 'mv', a: x(rd) + ',' + x(rs2), c: 'alu' };
        if (key === 0x100 && rs1 === 0) return { m: 'neg', a: x(rd) + ',' + x(rs2), c: 'alu' };
        if (key === 0x003 && rs1 === 0) return { m: 'snez', a: x(rd) + ',' + x(rs2), c: 'alu' };
        if (key === 0x002 && rs2 === 0) return { m: 'sltz', a: x(rd) + ',' + x(rs1), c: 'alu' };
        if (key === 0x002 && rs1 === 0) return { m: 'sgtz', a: x(rd) + ',' + x(rs2), c: 'alu' };
        if (n33[key]) return R(n33[key]);
        break;
      }
      case 0x3b: {
        var k3 = f7 << 3 | f3;
        if (f7 === 1) {
          var m3 = { 0: 'mulw', 4: 'divw', 5: 'divuw', 6: 'remw', 7: 'remuw' }[f3];
          if (m3) return R(m3, 'muldiv');
          break;
        }
        if (k3 === 0x024 && rs2 === 0) return { m: 'zext.h', a: x(rd) + ',' + x(rs1), c: 'alu' };
        if (k3 === 0x020 && rs2 === 0) return { m: 'zext.w', a: x(rd) + ',' + x(rs1), c: 'alu' };
        if (k3 === 0x100 && rs1 === 0) return { m: 'negw', a: x(rd) + ',' + x(rs2), c: 'alu' };
        var n3b = { 0x000: 'addw', 0x100: 'subw', 0x001: 'sllw', 0x005: 'srlw', 0x105: 'sraw', 0x020: 'add.uw',
          0x082: 'sh1add.uw', 0x084: 'sh2add.uw', 0x086: 'sh3add.uw', 0x181: 'rolw', 0x185: 'rorw' }[k3];
        if (n3b) return R(n3b);
        break;
      }
      case 0x0f:
        if (f3 === 0) {
          var pr = function (v) { return (v & 8 ? 'i' : '') + (v & 4 ? 'o' : '') + (v & 2 ? 'r' : '') + (v & 1 ? 'w' : ''); };
          var p = bits(i, 27, 24), s = bits(i, 23, 20);
          if (bits(i, 31, 28) === 8) return { m: 'fence.tso', a: '', c: 'fence' };
          return { m: 'fence', a: (p === 15 && s === 15) ? '' : pr(p) + ',' + pr(s), c: 'fence' };
        }
        if (f3 === 1) return { m: 'fence.i', a: '', c: 'fence' };
        if (f3 === 2) {
          var cb = { 0: 'cbo.inval', 1: 'cbo.clean', 2: 'cbo.flush', 4: 'cbo.zero' }[immI & 0xfff];
          if (cb) return { m: cb, a: '(' + x(rs1) + ')', c: 'store' };
        }
        break;
      case 0x73: {
        if (f3 === 0) {
          if (i === 0x00000073) return { m: 'ecall', a: '', c: 'system' };
          if (i === 0x00100073) return { m: 'ebreak', a: '', c: 'system' };
          if (i === 0x10200073) return { m: 'sret', a: '', c: 'system' };
          if (i === 0x30200073) return { m: 'mret', a: '', c: 'system' };
          if (i === 0x10500073) return { m: 'wfi', a: '', c: 'system' };
          if (f7 === 0x09 && rd === 0) {
            var sa = rs1 === 0 && rs2 === 0 ? '' : x(rs1) + (rs2 ? ',' + x(rs2) : '');
            return { m: 'sfence.vma', a: sa, c: 'system' };
          }
          break;
        }
        if (f3 === 4) break;
        var csr = csrName((immI & 0xfff) >>> 0), isImm = f3 >= 5, src = isImm ? String(rs1) : x(rs1);
        var base = ['', 'csrrw', 'csrrs', 'csrrc'][f3 & 3] + (isImm ? 'i' : '');
        if (f3 === 2 && rs1 === 0) return { m: 'csrr', a: x(rd) + ',' + csr, c: 'csr' };
        if (rd === 0) return { m: ['', 'csrw', 'csrs', 'csrc'][f3 & 3] + (isImm ? 'i' : ''), a: csr + ',' + src, c: 'csr' };
        return { m: base, a: x(rd) + ',' + csr + ',' + src, c: 'csr' };
      }
      case 0x2f: {
        if (f3 !== 2 && f3 !== 3) break;
        var f5 = bits(i, 31, 27), sfx = (f3 === 2 ? '.w' : '.d') + ['', '.rl', '.aq', '.aqrl'][bits(i, 26, 25)];
        var an = { 0: 'amoadd', 1: 'amoswap', 2: 'lr', 3: 'sc', 4: 'amoxor', 8: 'amoor', 12: 'amoand',
          16: 'amomin', 20: 'amomax', 24: 'amominu', 28: 'amomaxu' }[f5];
        if (!an) break;
        if (an === 'lr') return { m: 'lr' + sfx, a: x(rd) + ',(' + x(rs1) + ')', c: 'amo' };
        return { m: an + sfx, a: x(rd) + ',' + x(rs2) + ',(' + x(rs1) + ')', c: 'amo' };
      }
      case 0x43: case 0x47: case 0x4b: case 0x4f: {
        var fm = bits(i, 26, 25);
        if (fm > 1) break;
        var fn = { 0x43: 'fmadd', 0x47: 'fmsub', 0x4b: 'fnmsub', 0x4f: 'fnmadd' }[op] + (fm ? '.d' : '.s');
        return { m: fn, a: f(rd) + ',' + f(rs1) + ',' + f(rs2) + ',' + f(bits(i, 31, 27)), c: 'fp' };
      }
      case 0x53: {
        var fmt = f7 & 3, f5b = f7 >> 2, t = fmt === 0 ? '.s' : fmt === 1 ? '.d' : null;
        if (!t) break;
        var FF = function (m) { return { m: m + t, a: f(rd) + ',' + f(rs1) + ',' + f(rs2), c: 'fp' }; };
        switch (f5b) {
          case 0: return FF('fadd');
          case 1: return FF('fsub');
          case 2: return FF('fmul');
          case 3: return FF('fdiv');
          case 0x0b: return { m: 'fsqrt' + t, a: f(rd) + ',' + f(rs1), c: 'fp' };
          case 0x04:
            if (rs1 === rs2 && f3 < 3) return { m: ['fmv', 'fneg', 'fabs'][f3] + t, a: f(rd) + ',' + f(rs1), c: 'fp' };
            if (f3 < 3) return FF(['fsgnj', 'fsgnjn', 'fsgnjx'][f3]);
            break;
          case 0x05: if (f3 < 2) return FF(f3 ? 'fmax' : 'fmin'); break;
          case 0x08: return { m: 'fcvt' + t + (rs2 === 0 ? '.s' : '.d'), a: f(rd) + ',' + f(rs1), c: 'fp' };
          case 0x14: {
            var cn = ['fle', 'flt', 'feq'][f3];
            if (cn) return { m: cn + t, a: x(rd) + ',' + f(rs1) + ',' + f(rs2), c: 'fp' };
            break;
          }
          case 0x18: return { m: 'fcvt.' + ['w', 'wu', 'l', 'lu'][rs2 & 3] + t, a: x(rd) + ',' + f(rs1), c: 'fp' };
          case 0x1a: return { m: 'fcvt' + t + '.' + ['w', 'wu', 'l', 'lu'][rs2 & 3], a: f(rd) + ',' + x(rs1), c: 'fp' };
          case 0x1c:
            if (f3 === 0) return { m: 'fmv.x' + (fmt ? '.d' : '.w'), a: x(rd) + ',' + f(rs1), c: 'fp' };
            if (f3 === 1) return { m: 'fclass' + t, a: x(rd) + ',' + f(rs1), c: 'fp' };
            break;
          case 0x1e: if (f3 === 0) return { m: 'fmv' + (fmt ? '.d' : '.w') + '.x', a: f(rd) + ',' + x(rs1), c: 'fp' }; break;
        }
        break;
      }
    }
    return null;
  }

  // 命令を読み、{ m, a, c, rvc } を返す。読めなければ m は '.word' か '.half'
  function decode(insn, pc) {
    insn = insn >>> 0;
    var rvc = (insn & 3) !== 3;
    var full = rvc ? expand(insn & 0xffff) : insn;
    var d = full ? dec(full, pc) : null;
    if (!d) d = { m: rvc ? '.half' : '.word', a: hex(rvc ? insn & 0xffff : insn), c: 'illegal' };
    d.rvc = rvc;
    return d;
  }

  window.RVDIS = {
    ABI: ABI,
    FABI: FABI,
    csrName: csrName,
    expand: expand,
    decode: decode,
    disasm: function (insn, pc) { var d = decode(insn, pc); return d.a ? d.m + ' ' + d.a : d.m; },
    mnemonic: function (insn) { return decode(insn).m; },
    cls: function (insn) { return decode(insn).c; }
  };
})();
