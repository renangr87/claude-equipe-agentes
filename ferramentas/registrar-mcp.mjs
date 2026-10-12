// Registra um servidor MCP na configuração do usuário do Claude Code (.claude.json),
// para valer em todos os projetos (hoje, o codebase-memory: mapa do código).
//
// Uso: node registrar-mcp.mjs <arquivo .claude.json> <modelo .json> <carimbo do backup> <nome> [comando] [substituir]
//   nome:       a entrada de mcpServers no modelo
//   comando:    troca o "command" do modelo (por exemplo, o caminho completo do executável)
//   substituir: se já existir um servidor com o mesmo nome e ele for diferente do
//               modelo, troca pelo do modelo. Sem isso, a entrada existente é mantida.
//
// Antes de gravar,
// copia o arquivo para <arquivo>.bak-<carimbo>. Feito em Node porque o
// .claude.json pode ter vários MB, e o Windows PowerShell 5.1 tem limite
// para ler JSON grande.
//
// Saída: 0 = registrado ou já existia; 3 = arquivo inválido (nada foi alterado).
import fs from 'node:fs';

const [arquivo, modelo, carimbo, nome, comando, modo] = process.argv.slice(2);
if (!arquivo || !modelo || !carimbo || !nome) {
  console.error('Uso: node registrar-mcp.mjs <arquivo .claude.json> <modelo .json> <carimbo> <nome> [comando]');
  process.exit(3);
}

const entrada = JSON.parse(fs.readFileSync(modelo, 'utf8')).mcpServers[nome];
if (!entrada) {
  console.error(`O modelo ${modelo} não tem o servidor ${nome}.`);
  process.exit(3);
}
if (comando) entrada.command = comando;

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
const atual = dados.mcpServers[nome];
if (atual) {
  if (modo !== 'substituir') {
    console.log(`  servidor ${nome} já existe, mantido: ${arquivo}`);
    process.exit(0);
  }
  if (JSON.stringify(atual) === JSON.stringify(entrada)) {
    console.log(`  servidor ${nome} já está igual ao modelo: ${arquivo}`);
    process.exit(0);
  }
}

if (existe) {
  // Na mesma instalação podem entrar dois servidores: a cópia mais antiga
  // (o arquivo original) é a que fica.
  const bak = `${arquivo}.bak-${carimbo}`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(arquivo, bak);
    console.log(`  cópia de segurança: ${bak}`);
  }
}
dados.mcpServers[nome] = entrada;
fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2) + '\n');
console.log(`  servidor ${nome} ${atual ? 'atualizado' : 'registrado'}: ${arquivo}`);
