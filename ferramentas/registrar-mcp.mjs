// Registra o servidor chrome-devtools na configuração do usuário do Claude Code
// (.claude.json), para o subagente navegador funcionar em todos os projetos.
//
// Uso: node registrar-mcp.mjs <arquivo .claude.json> <modelo .json> <carimbo do backup>
//
// Não altera nada se já existir um servidor chrome-devtools. Antes de gravar,
// copia o arquivo para <arquivo>.bak-<carimbo>. Feito em Node porque o
// .claude.json pode ter vários MB, e o Windows PowerShell 5.1 tem limite
// para ler JSON grande.
//
// Saída: 0 = registrado ou já existia; 3 = arquivo inválido (nada foi alterado).
import fs from 'node:fs';

const [arquivo, modelo, carimbo] = process.argv.slice(2);
if (!arquivo || !modelo || !carimbo) {
  console.error('Uso: node registrar-mcp.mjs <arquivo .claude.json> <modelo .json> <carimbo>');
  process.exit(3);
}

const [maior, menor] = process.versions.node.split('.').map(Number);
const nodeServe = (maior === 20 && menor >= 19) || (maior === 22 && menor >= 12) || maior >= 23;
if (!nodeServe) {
  console.log(`  aviso: Node ${process.versions.node}. O Chrome DevTools MCP pede Node 20.19+, 22.12+ ou 23+.`);
}

const entrada = JSON.parse(fs.readFileSync(modelo, 'utf8')).mcpServers['chrome-devtools'];

let dados = {};
const existe = fs.existsSync(arquivo);
if (existe) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  if (texto.trim()) {
    try {
      dados = JSON.parse(texto);
    } catch (e) {
      console.error(`O arquivo ${arquivo} não é um JSON válido. Ele não foi alterado.`);
      process.exit(3);
    }
  }
}
if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
  console.error(`O arquivo ${arquivo} não tem o formato esperado (um objeto JSON). Ele não foi alterado.`);
  process.exit(3);
}
if (dados.mcpServers === undefined) dados.mcpServers = {};
if (dados.mcpServers === null || typeof dados.mcpServers !== 'object' || Array.isArray(dados.mcpServers)) {
  console.error(`A chave mcpServers de ${arquivo} não é um objeto. O arquivo não foi alterado.`);
  process.exit(3);
}
if (dados.mcpServers['chrome-devtools']) {
  console.log(`  servidor chrome-devtools já existe, mantido: ${arquivo}`);
  process.exit(0);
}

if (existe) {
  const bak = `${arquivo}.bak-${carimbo}`;
  fs.copyFileSync(arquivo, bak);
  console.log(`  cópia de segurança: ${bak}`);
}
dados.mcpServers['chrome-devtools'] = entrada;
fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2) + '\n');
console.log(`  servidor chrome-devtools registrado: ${arquivo}`);
