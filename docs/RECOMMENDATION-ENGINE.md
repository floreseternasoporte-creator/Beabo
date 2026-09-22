# DrexRecEngine v2 — Documentación del Motor de Recomendación

**Fecha:** 2026-09-22
**Versión:** 2.0
**Archivo:** `drex-rec-engine.js` (~2,100 líneas)

## Resumen

DrexRecEngine v2 es un motor de recomendación de nueva generación para la plataforma Drex/Beabo. Reemplaza el sistema anterior ("Drex Rec v1", ~300 líneas) con un motor modular de ~2,100 líneas que implementa múltiples técnicas avanzadas de ranking personalizado.

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                    DrexRecEngine                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │ ProfileStore │  │ SignalTracker │  │ ContentAnalyzer│   │
│  │ (V2: per-   │  │ (dwell, scroll│  │ (TF-IDF, n-   │   │
│  │  signal     │  │  viewport,    │  │  grams, topic │   │
│  │  decay)     │  │  media)       │  │  vectors)      │   │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘   │
│         │                 │                  │            │
│  ┌──────▼─────────────────▼──────────────────▼──────┐    │
│  │              RankingModel                         │    │
│  │  recency + popularity + personal + session +      │    │
│  │  trend + quality + social + novelty + exploration │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │            DiversityMixer                         │    │
│  │  anti-repetición + topic spread + author spread   │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │          BanditExplorer                           │    │
│  │  70% exploit / 20% explore / 10% trending          │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │          TrendingModel                            │    │
│  │  velocity scoring + viral detection               │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │          ColdStartModel                           │    │
│  │  new-user fallback + new-post boost window        │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │          SessionModel                             │    │
│  │  gustos de la sesión actual (se resetea parcial)  │    │
│  └──────────────────────┬───────────────────────────┘    │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │          Explainability                           │    │
│  │  explainPost() → { component, weight, ... }        │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## Componentes

### 1. ProfileStore
- Almacena el perfil de usuario en `userInterestsV2/<uid>` (DynamoDB).
- Migra automáticamente perfiles V1 (`userInterests/<uid>`) a V2.
- Decaimiento temporal por categoría (no global): flairs (21 días), authors (14 días), keywords (10 días), topics (18 días), formats (30 días), timeSlots (7 días).
- Estructura V2: flairs, authors, keywords, topics, formats, timeSlots, negativeAuthors, negativeKeywords, sessionItems, interactedPosts, bandit.

### 2. SignalTracker
- Dwell time granular: 1s, 3s, 8s, 20s (4 niveles de profundidad).
- Scroll velocity tracking (detecta skips rápidos).
- Media clicks, abrir comentarios.
- Señales negativas: ocultar, reportar, bloquear autor.
- IntersectionObserver con threshold 0.35.

### 3. ContentAnalyzer
- Extracción de keywords: palabras latinas (4+ letras), bigramas, bigramas CJK.
- Stopwords ampliadas (ES + EN).
- Topic vectors (TF-IDF aproximado local).
- Similitud coseno entre topic vectors.
- Similitud de Jaccard entre keyword sets.
- Detección de formato: video, gallery, image, poll, text, other.
- Score de calidad de contenido (longitud óptima, multimedia).

### 4. SessionModel
- Captura preferencias de la sesión actual (última hora).
- Se resetea parcialmente entre sesiones.
- Da peso fuerte a interacciones recientes.
- Decae con el tiempo dentro de la sesión.

### 5. RankingModel
Puntaje final con 11 componentes:
- **Recencia:** decaimiento exponencial (vida media 26h).
- **Popularidad global:** log de votos netos + comentarios + ecos.
- **Afinidad personal:** flair + author + keywords + topic similarity + format preference.
- **Afinidad de sesión:** interacciones recientes (última hora).
- **Trending:** velocidad de interacciones por hora.
- **Calidad:** longitud, multimedia, ratio de engagement.
- **Social:** boost por following (más fuerte para follows recientes).
- **Novedad:** boost por posts no vistos, penalización por ya vistos.
- **Exploración:** impulso anti-burbuja (18% de probabilidad).
- **Diversidad:** penaliza repetición de autor/flair/formato.
- **Feedback negativo:** penalización fuerte por autores/keywords negativos.

### 6. DiversityMixer
- 5 buckets: personal, trending, fresh, following, explore.
- 70% explotación / 20% exploración / 10% trending.
- Penalización por repetición en ventana deslizante de 10.
- Máximos: 3 same author, 4 same flair, 5 same format en ventana.

### 7. BanditExplorer
- Multi-armed bandit con 5 buckets.
- Pesos ajustables con learning rate 0.05.
- Recompensa basada en interacciones del usuario.
- Pesos mínimos (0.03) y máximos (0.70).
- Estado persistido en el perfil V2.

### 8. TrendingModel
- Velocity scoring: interacciones/hora.
- Boost de post fresco (primeras 24h, decaimiento lineal).
- Detección viral: interacciones/hora > umbral.
- Multiplicador viral (1.5x).
- Boost máximo por velocidad: 25 puntos.

### 9. ColdStartModel
- Usuario nuevo (< 15 interacciones): mezcla 60% cold start + 40% ranking normal.
- Cold start score: frescura + popularidad + diversidad + format bonus.
- Post nuevo: boost de exposición en primeras 24h.

### 10. SocialGraph
- Author authority (followers count + verified).
- Social boost por following (con recency boost para follows nuevos).

### 11. QualitySignals
- Engagement ratio: (comentarios + ecos) / (votos + 1).
- Controversy score: posts con votos up/down balanceados.
- Quality score combinado.

### 12. Explainability
- `explainPost(note)` devuelve desglose completo del score.
- Lista cada componente con su valor, peso y contribución.

## Rutas de datos (DynamoDB)

| Ruta | Descripción |
|------|-------------|
| `userInterestsV2/<uid>` | Perfil V2 del usuario (reemplaza `userInterests/<uid>`) |
| `recBandit/<uid>` | Estado del multi-armed bandit (dentro del perfil) |
| `postStats/<noteId>` | Estadísticas agregadas por post (futuro) |

## Compatibilidad V1

Las funciones globales antiguas se puentean automáticamente al motor V2:
- `drexRecScore()` → `DrexRecEngine.scorePost()`
- `drexRecTrain()` → `DrexRecEngine.train()`
- `drexRecProfile()` → `ProfileStore.load()`
- `drexRecObserveCard()` → `SignalTracker.observeCard()`
- `drexRecInsertForYou()` → `DrexRecEngine.insertByScore()`
- `drexRecResortForYou()` → `DrexRecEngine.resortForYou()`
- `drexRecTrainById()` → `DrexRecEngine.trainById()`
- `drexRecTrainFollow()` → `DrexRecEngine.trainFollow()`

El objeto `DREX_REC` se actualiza para usar las constantes V2.

## Integración en index.html

1. `<script defer src="drex-rec-engine.js">` se incluye después de `drex-cloud.js`.
2. Los puntos de entrenamiento existentes usan las funciones puenteadas.
3. Nuevas señales: ocultar post, abrir comentarios, click en media.
4. `loadNotes()` reordena "Para ti" 1.2s después de cargar el perfil V2.

## Tests

```bash
node tests/test-recommendation-engine.js
```

34 tests cubren: ContentAnalyzer, ProfileStore, SignalTracker, SessionModel, TrendingModel, ColdStartModel, RankingModel, DiversityMixer, BanditExplorer, QualitySignals, SocialGraph, Explainability, e integración V1.
