#!/usr/bin/env python3
"""Drex Orbit — i18n (drex-i18n.js). Inserta las claves ES faltantes con
traducciones EN/ZH/PT antes del cierre de cada diccionario TEXT."""
import sys

P = '/home/hatch/workspace/beabo/drex-i18n.js'
src = open(P, encoding='utf-8').read()

# (es, en, zh, pt)
T = [
("Anual", "Annual", "年度", "Anual"),
("Mensual", "Monthly", "月度", "Mensal"),
("al mes", "per month", "每月", "por mês"),
("al año", "per year", "每年", "por ano"),
("El plan Orbit de Drex", "Drex Orbit plan", "Drex Orbit 方案", "O plano Orbit do Drex"),
("Drex Orbit no está disponible en este momento. Inténtalo más tarde.", "Drex Orbit isn't available right now. Try again later.", "Drex Orbit 暂时不可用，请稍后再试。", "Drex Orbit não está disponível no momento. Tente novamente mais tarde."),
("Tu suscripción", "Your subscription", "你的订阅", "Sua assinatura"),
("Se cancela al final del periodo", "Cancels at the end of the period", "将在周期结束时取消", "Será cancelada ao fim do período"),
("Se renueva el", "Renews on", "续订于", "Renova em"),
("Tu último pago falló. Actualiza tu método de pago para mantener Drex Orbit.", "Your last payment failed. Update your payment method to keep Drex Orbit.", "你最近一次付款失败，请更新付款方式以保留 Drex Orbit。", "Seu último pagamento falhou. Atualize sua forma de pagamento para manter o Drex Orbit."),
("Gestionar suscripción", "Manage subscription", "管理订阅", "Gerenciar assinatura"),
("Restaurar compra", "Restore purchase", "恢复购买", "Restaurar compra"),
("Tus beneficios", "Your benefits", "你的权益", "Seus benefícios"),
("Sin anuncios", "Ad-free", "无广告", "Sem anúncios"),
("Navega Drex sin publicidad.", "Browse Drex with no ads.", "畅享无广告的 Drex。", "Navegue no Drex sem publicidade."),
("Insignia y marco exclusivos", "Exclusive badge & frame", "专属徽章和头像框", "Selo e moldura exclusivos"),
("Distintivo dorado Drex Orbit y marco en tu foto.", "Gold Drex Orbit badge and frame on your photo.", "金色 Drex Orbit 徽章与头像框。", "Selo dourado Drex Orbit e moldura na sua foto."),
("Temas de perfil Orbit", "Orbit profile themes", "Orbit 个人主页主题", "Temas de perfil Orbit"),
("Fondos exclusivos para tu portada.", "Exclusive covers for your profile.", "专属个人主页封面背景。", "Fundos exclusivos para sua capa."),
("Drex Studio Pro", "Drex Studio Pro", "Drex Studio 专业版", "Drex Studio Pro"),
("Plantillas y escenas profesionales en alta calidad.", "Pro templates and scenes in high quality.", "高质量专业模板与场景。", "Modelos e cenas profissionais em alta qualidade."),
("En vivos potenciados", "Boosted live streams", "强化直播", "Lives potencializadas"),
("Más duración, calidad HD y más en vivos programados.", "Longer duration, HD quality and more scheduled lives.", "更长时长、高清画质与更多预约直播。", "Mais duração, qualidade HD e mais lives agendadas."),
("Límites elevados", "Higher limits", "更高额度", "Limites maiores"),
("Videos más largos, más fotos y publicaciones programadas.", "Longer videos, more photos and scheduled posts.", "更长视频、更多照片与定时发布。", "Vídeos mais longos, mais fotos e publicações agendadas."),
("Analíticas de creador", "Creator analytics", "创作者数据分析", "Análises de criador"),
("Estadísticas avanzadas de tu contenido.", "Advanced stats for your content.", "内容高级数据统计。", "Estatísticas avançadas do seu conteúdo."),
("Regalos exclusivos", "Exclusive gifts", "专属礼物", "Presentes exclusivos"),
("Regalos originales solo para miembros Drex Orbit.", "Original gifts only for Drex Orbit members.", "仅限 Drex Orbit 会员的原创礼物。", "Presentes originais só para membros Drex Orbit."),
("Soporte prioritario", "Priority support", "优先客服", "Suporte prioritário"),
("Tus reportes se atienden primero.", "Your reports get answered first.", "你的反馈将优先处理。", "Suas denúncias são atendidas primeiro."),
("Elegir plan", "Choose a plan", "选择方案", "Escolher plano"),
("Ahorra 2 meses", "Save 2 months", "节省 2 个月", "Economize 2 meses"),
("Suscribirme", "Subscribe", "订阅", "Assinar"),
("Pago 100% seguro con Stripe. Sin permanencia. Cancela cuando quieras.", "100% secure payment with Stripe. No commitment. Cancel anytime.", "通过 Stripe 100% 安全支付。无合约，随时取消。", "Pagamento 100% seguro com Stripe. Sem fidelidade. Cancele quando quiser."),
("Tema de perfil", "Profile theme", "主页主题", "Tema de perfil"),
("Elige el fondo de tu portada", "Choose your cover background", "选择封面背景", "Escolha o fundo da sua capa"),
("Tus números reales, actualizados al abrir.", "Your real numbers, updated on open.", "真实数据，每次打开自动更新。", "Seus números reais, atualizados ao abrir."),
("Sin anuncios, insignia exclusiva y mucho más.", "Ad-free, exclusive badge and much more.", "无广告、专属徽章，还有更多。", "Sem anúncios, selo exclusivo e muito mais."),
("Miembro activo", "Active member", "在籍会员", "Membro ativo"),
("Pagos", "Payments", "付款", "Pagamentos"),
("Historial de pagos y compras", "Payment & purchase history", "付款与购买记录", "Histórico de pagamentos e compras"),
("Tus movimientos reales de Drex Coins y Drex Orbit.", "Your real Drex Coins and Drex Orbit transactions.", "你的 Drex Coins 与 Drex Orbit 真实交易记录。", "Suas transações reais de Drex Coins e Drex Orbit."),
("Aún no tienes movimientos", "No transactions yet", "暂无交易记录", "Ainda não há transações"),
("Tus compras y pagos aparecerán aquí automáticamente.", "Your purchases and payments will appear here automatically.", "你的购买与付款将自动显示在这里。", "Suas compras e pagamentos aparecerão aqui automaticamente."),
("Suscripción Drex Orbit", "Drex Orbit subscription", "Drex Orbit 订阅", "Assinatura Drex Orbit"),
("Plan actual", "Current plan", "当前方案", "Plano atual"),
("Cancelar suscripción", "Cancel subscription", "取消订阅", "Cancelar assinatura"),
("Cambiar de plan", "Change plan", "更改方案", "Mudar de plano"),
("Actualizar método de pago", "Update payment method", "更新付款方式", "Atualizar forma de pagamento"),
("Gestionar en el portal seguro de Stripe", "Manage in Stripe's secure portal", "在 Stripe 安全门户中管理", "Gerenciar no portal seguro do Stripe"),
("Compra de Drex Coins", "Drex Coins purchase", "购买 Drex Coins", "Compra de Drex Coins"),
("Pago de Drex Orbit", "Drex Orbit payment", "Drex Orbit 付款", "Pagamento Drex Orbit"),
("Completado", "Completed", "已完成", "Concluído"),
("Fallido", "Failed", "失败", "Falhou"),
("Cargando tu historial…", "Loading your history…", "正在加载你的记录…", "Carregando seu histórico…"),
("No pudimos cargar tu historial. Inténtalo de nuevo.", "We couldn't load your history. Try again.", "无法加载你的记录，请重试。", "Não foi possível carregar seu histórico. Tente novamente."),
("Reintentar", "Retry", "重试", "Tentar novamente"),
("monedas", "coins", "金币", "moedas"),
("Procesando…", "Processing…", "处理中…", "Processando…"),
("Error al iniciar el pago. Inténtalo de nuevo.", "Couldn't start the payment. Try again.", "无法发起付款，请重试。", "Não foi possível iniciar o pagamento. Tente de novo."),
("Inicia sesión para suscribirte a Drex Orbit.", "Sign in to subscribe to Drex Orbit.", "登录后订阅 Drex Orbit。", "Entre para assinar o Drex Orbit."),
("No tienes una suscripción activa.", "You don't have an active subscription.", "你没有有效订阅。", "Você não tem uma assinatura ativa."),
("No se pudo abrir la gestión de la suscripción. Inténtalo de nuevo.", "Couldn't open subscription management. Try again.", "无法打开订阅管理，请重试。", "Não foi possível abrir o gerenciamento da assinatura. Tente de novo."),
("¡Bienvenido a Drex Orbit! Tu suscripción ya está activa.", "Welcome to Drex Orbit! Your subscription is now active.", "欢迎加入 Drex Orbit！你的订阅已生效。", "Bem-vindo ao Drex Orbit! Sua assinatura já está ativa."),
("No encontramos una suscripción activa en tu cuenta.", "We couldn't find an active subscription on your account.", "未在你的帐户中找到有效订阅。", "Não encontramos uma assinatura ativa na sua conta."),
("No se pudo verificar tu suscripción. Inténtalo de nuevo.", "Couldn't verify your subscription. Try again.", "无法验证你的订阅，请重试。", "Não foi possível verificar sua assinatura. Tente de novo."),
("Pago recibido. Tu suscripción se activará en unos segundos.", "Payment received. Your subscription will activate in a few seconds.", "已收到付款，你的订阅将在几秒后生效。", "Pagamento recebido. Sua assinatura será ativada em alguns segundos."),
("Suscripción cancelada. No se realizó ningún cargo.", "Subscription cancelled. No charge was made.", "订阅已取消，未产生任何扣费。", "Assinatura cancelada. Nenhuma cobrança foi feita."),
("Esta función es de Drex Orbit", "This feature is Drex Orbit", "此功能为 Drex Orbit 专属", "Este recurso é do Drex Orbit"),
("Suscríbete para desbloquearla y apoyar a Drex.", "Subscribe to unlock it and support Drex.", "订阅即可解锁并支持 Drex。", "Assine para desbloquear e apoiar o Drex."),
("Ver planes", "View plans", "查看方案", "Ver planos"),
("Ahora no", "Not now", "稍后再说", "Agora não"),
("Sin permanencia. Cancela cuando quieras.", "No commitment. Cancel anytime.", "无合约，随时取消。", "Sem fidelidade. Cancele quando quiser."),
("Predeterminado", "Default", "默认", "Padrão"),
("Índigo", "Indigo", "靛蓝", "Índigo"),
("Medianoche", "Midnight", "午夜", "Meia-noite"),
("Dorado", "Gold", "金色", "Dourado"),
("Océano", "Ocean", "海洋", "Oceano"),
("Atardecer", "Sunset", "落日", "Pôr do sol"),
("Galaxia", "Galaxy", "星系", "Galáxia"),
("Esmeralda", "Emerald", "祖母绿", "Esmeralda"),
("Neón", "Neon", "霓虹", "Neon"),
("Solo Drex Orbit", "Drex Orbit only", "仅限 Drex Orbit", "Somente Drex Orbit"),
("Tema aplicado", "Theme applied", "主题已应用", "Tema aplicado"),
("No se pudo guardar el tema. Inténtalo de nuevo.", "Couldn't save the theme. Try again.", "无法保存主题，请重试。", "Não foi possível salvar o tema. Tente de novo."),
("Inicia sesión para personalizar tu perfil.", "Sign in to customize your profile.", "登录后自定义个人主页。", "Entre para personalizar seu perfil."),
("Tu en vivo terminará en 15 minutos.", "Your live will end in 15 minutes.", "你的直播将在 15 分钟后结束。", "Sua live terminará em 15 minutos."),
("Tu en vivo alcanzó el límite de duración.", "Your live reached its duration limit.", "你的直播已达到时长上限。", "Sua live atingiu o limite de duração."),
("Límite de en vivos programados alcanzado", "Scheduled lives limit reached", "已达到预约直播上限", "Limite de lives agendadas atingido"),
("El video puede durar hasta {s} segundos. Elige un clip más corto.", "Videos can be up to {s} seconds. Choose a shorter clip.", "视频最长可为 {s} 秒，请选择更短的片段。", "O vídeo pode ter até {s} segundos. Escolha um clipe mais curto."),
("Solo puedes subir un máximo de {n} fotos por publicación.", "You can upload up to {n} photos per post.", "每个帖子最多可上传 {n} 张照片。", "Você pode subir no máximo {n} fotos por publicação."),
]

def esc(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')

# Localiza el cierre de cada diccionario TEXT
def dict_range(src, start_marker, end_marker):
    s = src.index(start_marker)
    e = src.index(end_marker, s)
    return s, e

DICTS = [
    ('var APP_ENGLISH_TEXT = {', 'var APP_CHINESE_TEXT = {'),
    ('var APP_CHINESE_TEXT = {', 'var APP_PORTUGUESE_TEXT = {'),
    ('var APP_PORTUGUESE_TEXT = {', 'var APP_ENGLISH_ATTRS = {'),
]

added = [0, 0, 0]
# Recalcular el rango de cada diccionario DESDE EL SRC ACTUAL en cada
# iteración (el src crece con cada inserción; los rangos precalculados
# quedaban stale y el ZH no recibía las claves).
for di, (start_marker, end_marker) in enumerate(DICTS):
    s, e = dict_range(src, start_marker, end_marker)
    block = src[s:e]
    # cierre: último "};" del bloque
    close_at = block.rstrip().rfind('};')
    assert close_at > 0, f'dict {di}: sin cierre'
    entries = []
    for (es, en, zh, pt) in T:
        val = [en, zh, pt][di]
        # ¿ya existe la clave? (tolerante a comentarios previos en la línea)
        key_pat = '"' + esc(es) + '":'
        if key_pat in block:
            continue
        entries.append('"' + esc(es) + '":"' + esc(val) + '",')
    if not entries:
        print(f'dict {di}: sin claves nuevas')
        continue
    ins = '/* DREX-ORBIT */' + ''.join(entries)
    # insertar antes del "};" de cierre (el bloque termina con ",\n};")
    at = s + close_at
    src = src[:at] + ins + '\n' + src[at:]
    added[di] = len(entries)
    print(f'dict {di}: +{len(entries)} claves')

open(P, 'w', encoding='utf-8').write(src)
print(f'LISTO: EN +{added[0]}, ZH +{added[1]}, PT +{added[2]} (total claves: {len(T)})')
