"""
Complementa data/ano_anterior.json com lojas que em 2025 ainda não estavam no Degust e só existem na
tabela diária antiga bd_espetto.dbo.[BD VENDAS] (faturamento e clientes por dia, sem comandas nem produtos).

  python extrator/complementar_ano_anterior.py

Hoje: ESP GRANDE RIO (dados de 15/10 a 09/11/2025; de 10/11 a 10/12/2025 a loja não aparece em nenhuma base).
Faturamento = [Faturamento Bruto] - DELIVERY, como na query de referência da BD VENDAS.
As linhas entram com comandas = 0 e a loja fica listada em "so_faturamento": o dashboard compara só o
faturamento dela, nos dias que têm dado em 2025, e não a usa em comandas, ticket médio e comandas > R$ 250.
Pode rodar mais de uma vez: as linhas dessas lojas são substituídas.
"""
import datetime as dt
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atualizar_dados import BASE, ROOT, connect, fetch, load_env, norm  # noqa: E402

LOJAS = ['ESP GRANDE RIO']
FONTE = 'bd_espetto.dbo.[BD VENDAS] (faturamento diário, sem comandas)'

SQL = """
SELECT P.LOJA AS loja, CAST(P.DATA AS date) AS data,
       SUM(P.[Faturamento Bruto] - P.DELIVERY) AS fat, SUM(P.[TOTAL CLIENTES]) AS tc
FROM bd_espetto.dbo.[BD VENDAS] P
WHERE P.DATA >= ? AND P.DATA <= ? AND P.LOJA IN ({marcas})
GROUP BY P.LOJA, CAST(P.DATA AS date)
"""


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    arq = ROOT / 'data' / 'ano_anterior.json'
    aa = json.loads(arq.read_text(encoding='utf-8'))
    lojas = json.loads((BASE / 'lojas.json').read_text(encoding='utf-8'))
    idx_loja = {norm(l['codigo']): i for i, l in enumerate(lojas)}
    idx_dia = {d: i for i, d in enumerate(aa['dias'])}
    alvo = {idx_loja[norm(c)]: c for c in LOJAS}

    cn = connect(load_env())
    sql = SQL.format(marcas=', '.join('?' * len(LOJAS)))
    linhas = fetch(cn, sql, (aa['periodo']['inicio'], aa['periodo']['fim'], *LOJAS), 'BD VENDAS')
    cn.close()

    novas, info = [], {}
    for r in linhas:
        li = idx_loja.get(norm(r.loja))
        d = r.data.isoformat()
        if li not in alvo or d not in idx_dia or not r.fat:
            continue
        novas.append([li, idx_dia[d], round(float(r.fat), 2), 0, 0, 0])
        i = info.setdefault(lojas[li]['codigo'], {'fonte': FONTE, 'de': d, 'ate': d, 'clientes': 0})
        i['de'], i['ate'] = min(i['de'], d), max(i['ate'], d)
        i['clientes'] += int(r.tc or 0)

    aa['vendas'] = sorted([v for v in aa['vendas'] if v[0] not in alvo] + novas, key=lambda v: (v[0], v[1]))
    aa['so_faturamento'] = info
    aa['complementado_em'] = dt.datetime.now().astimezone().isoformat(timespec='seconds')
    arq.write_text(json.dumps(aa, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for cod, i in info.items():
        fat = sum(v[2] for v in novas if lojas[v[0]]['codigo'] == cod)
        logging.info('%s: %s a %s, R$ %.2f, %d clientes', cod, i['de'], i['ate'], fat, i['clientes'])
    sem = [c for c in LOJAS if c not in info]
    if sem:
        logging.warning('Sem dados na BD VENDAS: %s', ', '.join(sem))


if __name__ == '__main__':
    main()
