// Relator do node --test para o GitHub Actions: cada teste que falha vira uma anotação
// (::error::), que aparece no resumo da execução e pode ser lida pela API sem baixar o log.
export default async function* anotacoes(eventos) {
  for await (const evento of eventos) {
    if (evento.type !== 'test:fail') continue;
    const d = evento.data || {};
    if (d.details && d.details.type === 'suite') continue;
    const erro = d.details && d.details.error;
    const causa = erro && (erro.cause || erro);
    const texto = String((causa && (causa.message || causa)) || 'falhou')
      .replace(/\r?\n/g, ' | ').replace(/::/g, ': :').slice(0, 1500);
    yield `::error::Node ${process.version} - FALHOU: ${d.name}: ${texto}\n`;
  }
}
