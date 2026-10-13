"""
Executa o corpo da procedure como consulta (somente leitura, tabelas temporárias), as 3 partes em paralelo,
medindo tempo e tamanho de cada uma — sem precisar criar a procedure no banco.
Uso: python sql/testar_procedure.py 2026-10-06 2026-10-12 [pasta_saida]
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'extrator'))
from atualizar_dados import connect, load_env  # noqa: E402

PARTES = ['vendas', 'produtos_espetto', 'produtos_parceiros']
sql = (Path(__file__).parent / 'sp_dashboard_copo15.sql').read_text(encoding='utf-8')
corpo = sql.split('-- <corpo>')[1].split('-- </corpo>')[0]
ini, fim = sys.argv[1], sys.argv[2]
saida = Path(sys.argv[3]) if len(sys.argv) > 3 else None
env = load_env()


def rodar(parte):
    batch = f"DECLARE @inicio date = '{ini}', @fim date = '{fim}', @parte varchar(20) = '{parte}';\n" + corpo
    cn = connect(env)
    cur = cn.cursor()
    t = time.time()
    cur.execute(batch)
    while cur.description is None:
        cur.nextset()
    payload = cur.fetchone()[0]
    cn.close()
    if saida:
        (saida / f'sp_{parte}.json').write_text(payload, encoding='utf-8')
    return parte, time.time() - t, len(payload.encode('utf-8')) / 1024


t0 = time.time()
with ThreadPoolExecutor(3) as ex:
    for parte, seg, kb in ex.map(rodar, PARTES):
        print(f'{parte:20s} {seg:6.1f}s {kb:8.0f} KB', flush=True)
print(f'total (paralelo): {time.time() - t0:.1f}s')
