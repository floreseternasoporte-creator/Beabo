# Guía de Rediseño de Comunidad - Estilo Reddit

## 📋 Resumen Ejecutivo

Se ha rediseñado completamente la sección de comunidad de Beaboo para que funcione de manera similar a **Reddit**, manteniendo los colores y estilos actuales de la plataforma (rosa #FE2C55 como color primario).

### Cambios Principales

| Aspecto | Antes | Después |
|---------|-------|---------|
| **Sistema de Votación** | Solo "likes" (corazón) | Upvote/Downvote (flechas) |
| **Ordenamiento** | No disponible | Hot, New, Top, Rising |
| **Estructura de Feed** | Simple y espaciada | Compacta estilo Reddit |
| **Sidebar** | No existe | Información de comunidad, reglas, moderadores |
| **Acciones por Post** | Like, Delete/Report | Upvote, Downvote, Comentar, Compartir |
| **Densidad Visual** | Espaciada | Compacta pero clara |
| **Formulario de Creación** | Oculto en tabs | Modal prominente + botón en sidebar |

---

## 🎨 Estructura Visual

### Layout Principal

```
┌─────────────────────────────────────────────────────┬──────────────────┐
│                   HEADER (Sticky)                   │                  │
│  ← Back | Community | [Sort Buttons: Hot/New/Top]   │   SIDEBAR        │
├─────────────────────────────────────────────────────┤   (Desktop Only) │
│                                                     │                  │
│  [Create Post Section]                              │  • About         │
│  ┌───────────────────────────────────────────────┐  │  • Create Post   │
│  │ [Avatar] What's on your mind?                 │  │  • Rules         │
│  └───────────────────────────────────────────────┘  │  • Moderators    │
│                                                     │                  │
│  ┌───────────────────────────────────────────────┐  │                  │
│  │ [Post Card 1]                                 │  │                  │
│  │ ⬆️ 234  ⬇️ 45  💬 12  ↗️ 5  ⋯                 │  │                  │
│  └───────────────────────────────────────────────┘  │                  │
│                                                     │                  │
│  ┌───────────────────────────────────────────────┐  │                  │
│  │ [Post Card 2]                                 │  │                  │
│  │ ⬆️ 156  ⬇️ 23  💬 8   ↗️ 3  ⋯                 │  │                  │
│  └───────────────────────────────────────────────┘  │                  │
│                                                     │                  │
└─────────────────────────────────────────────────────┴──────────────────┘
```

### Estructura de un Post

```
┌─────────────────────────────────────────┐
│ [Avatar] Nombre | r/Community | hace 2h │ ⋯
├─────────────────────────────────────────┤
│ Contenido del post (200 caracteres)     │
│ [Imagen si existe]                      │
├─────────────────────────────────────────┤
│ 234 upvotes  |  45 downvotes  |  12 comentarios
├─────────────────────────────────────────┤
│ ⬆️ Upvote  ⬇️ Downvote  💬 Comentar  ↗️ Compartir
└─────────────────────────────────────────┘
```

---

## 🔄 Sistema de Votación (Upvote/Downvote)

### Características

1. **Upvote (Flecha Arriba)**
   - Color: Rosa #FE2C55 cuando está activo
   - Incrementa el contador de votos positivos
   - Solo se puede tener un voto por post

2. **Downvote (Flecha Abajo)**
   - Color: Gris cuando está activo
   - Incrementa el contador de votos negativos
   - Solo se puede tener un voto por post

3. **Lógica de Votación**
   - Si el usuario hace upvote y luego downvote, se cambia el voto
   - Si el usuario hace upvote nuevamente, se cancela el voto
   - Los votos se persisten en la base de datos

### Implementación

```javascript
// Estructura de datos
communityState.userVotes = {
  'noteId123': 'upvote',    // Usuario votó positivo
  'noteId456': 'downvote',  // Usuario votó negativo
  'noteId789': null         // Usuario no votó
}

// Funciones principales
toggleUpvote(noteId, upvoteBtn, downvoteBtn)
toggleDownvote(noteId, upvoteBtn, downvoteBtn)
updateVote(noteId, voteType)
removeVote(noteId)
```

---

## 🔀 Sistema de Ordenamiento

### Opciones de Ordenamiento

1. **🔥 Hot** (Predeterminado)
   - Combina popularidad reciente + interacción
   - Fórmula: `(likes + comments*2) ordenado descendente`
   - Ideal para descubrir contenido popular ahora

2. **✨ New**
   - Posts más recientes primero
   - Ideal para ver contenido nuevo

3. **⭐ Top**
   - Posts con más likes
   - Ideal para contenido de calidad

4. **📈 Rising**
   - Posts ganando popularidad rápidamente
   - Fórmula: `likes / edad_en_horas` ordenado descendente
   - Ideal para descubrir tendencias

### Implementación

```javascript
function sortCommunityNotes(sortType) {
  communityState.currentSort = sortType;
  sortNotesInMemory();
  renderNotes();
}

// Cada tipo de ordenamiento tiene su propia lógica
// en la función sortNotesInMemory()
```

---

## 📱 Sidebar (Información de Comunidad)

### Componentes del Sidebar

1. **About Community**
   - Número de miembros
   - Usuarios activos ahora
   - Descripción de la comunidad

2. **Create Post Button**
   - Botón prominente en rosa #FE2C55
   - Abre el modal de creación de post

3. **Rules**
   - Lista de reglas de la comunidad
   - 4 reglas predeterminadas

4. **Moderators**
   - Lista de moderadores
   - Avatares + nombres

### Responsividad

- **Desktop (1024px+)**: Sidebar visible en la derecha
- **Tablet/Mobile (< 1024px)**: Sidebar oculto, información accesible en header

---

## ✍️ Creación de Posts

### Modal de Creación

1. **Header**
   - Título "Create a Post"
   - Botón cerrar (X)

2. **Información del Usuario**
   - Avatar del usuario
   - Nombre del usuario
   - Texto "Posting to Community"

3. **Formulario**
   - Textarea para contenido (máx 200 caracteres)
   - Contador de caracteres dinámico
   - Botón para agregar foto
   - Preview de imagen

4. **Acciones**
   - Botón "Add Photo" (gris)
   - Botón "Post" (rosa #FE2C55)

### Funciones

```javascript
showCreatePostForm()      // Abre el modal
closeCreatePostForm()     // Cierra el modal
handlePostImagePreview()  // Muestra preview de imagen
removeImageModal()        // Elimina imagen
publishPost()             // Publica el post
uploadPostImage()         // Sube imagen a Firebase
```

---

## 🎨 Paleta de Colores

| Elemento | Color | Código |
|----------|-------|--------|
| Primario (Upvote, Botones) | Rosa TikTok | #FE2C55 |
| Fondo | Blanco | #FFFFFF |
| Fondo Secundario | Gris Claro | #F8F9FA |
| Texto Principal | Negro | #000000 |
| Texto Secundario | Gris Oscuro | #666666 |
| Bordes | Gris Claro | #E5E7EB |
| Downvote | Gris | #666666 |
| Hover | Rosa Oscuro | #EF2950 |

---

## 📊 Estadísticas de Posts

Cada post muestra:

- **Upvotes**: Número de votos positivos
- **Downvotes**: Número de votos negativos
- **Comments**: Número de comentarios (futuro)
- **Shares**: Número de comparticiones

---

## 🔗 Acciones de Posts

### Botones de Acción

1. **⬆️ Upvote**
   - Incrementa votos positivos
   - Color rosa cuando está activo
   - Requiere autenticación

2. **⬇️ Downvote**
   - Incrementa votos negativos
   - Color gris cuando está activo
   - Requiere autenticación

3. **💬 Comment** (Futuro)
   - Abre modal de comentarios
   - Permite responder a posts

4. **↗️ Share**
   - Usa Web Share API si está disponible
   - Fallback: Copia a clipboard

5. **⋯ Menu**
   - Para propietarios: Editar, Eliminar
   - Para otros usuarios: Reportar

---

## 🔄 Flujo de Datos

```
┌─────────────────────────────────────────────────────┐
│ 1. Usuario abre comunidad                           │
│    → initializeCommunity()                          │
│    → loadCommunityInfo()                            │
│    → loadNotes()                                    │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ 2. Notas se cargan desde Firebase                   │
│    → fetch('/.netlify/functions/get-notes')         │
│    → communityState.notes = result.notes            │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ 3. Notas se ordenan en memoria                      │
│    → sortNotesInMemory()                            │
│    → Aplica lógica según sortType                   │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ 4. Notas se renderizan                              │
│    → renderNotes()                                  │
│    → createPostElement() para cada nota             │
│    → Agregar event listeners                        │
└─────────────────────────────────────────────────────┘
```

---

## 📁 Archivos Incluidos

1. **community-redesign.html**
   - Estructura HTML completa
   - Template para posts
   - Modal de creación
   - Estilos CSS

2. **community-redesign.js**
   - Lógica completa de la comunidad
   - Sistema de votación
   - Ordenamiento
   - Creación de posts
   - Utilidades

3. **COMMUNITY_REDESIGN_GUIDE.md**
   - Esta guía
   - Documentación completa

---

## 🚀 Próximos Pasos

### Implementación Inmediata

1. Reemplazar la sección `#community-view` en `index.html` con el contenido de `community-redesign.html`
2. Agregar `community-redesign.js` al archivo principal
3. Actualizar estilos en `stories.css` si es necesario
4. Probar en navegadores desktop y mobile

### Mejoras Futuras

1. **Sistema de Comentarios**
   - Modal de comentarios
   - Comentarios anidados
   - Votación en comentarios

2. **Notificaciones**
   - Cuando alguien upvotea tu post
   - Cuando alguien comenta
   - Cuando alguien te sigue

3. **Filtros Avanzados**
   - Por categoría
   - Por usuario
   - Por fecha

4. **Búsqueda**
   - Buscar posts
   - Buscar usuarios

5. **Estadísticas de Usuario**
   - Posts creados
   - Votos recibidos
   - Comentarios

---

## 🐛 Notas Técnicas

### Dependencias

- Firebase (ya está en el proyecto)
- Tailwind CSS (ya está en el proyecto)
- Font Awesome (ya está en el proyecto)

### APIs Esperadas

```javascript
// GET
/.netlify/functions/get-notes?limit=50

// POST
/.netlify/functions/upload-note
/.netlify/functions/vote-on-note

// DELETE
/.netlify/functions/delete-note
```

### Estado Local

```javascript
communityState = {
  currentSort: 'hot',           // Ordenamiento actual
  notes: [],                    // Array de notas
  userVotes: {},                // Votos del usuario
  isLoading: false              // Estado de carga
}
```

---

## ✅ Checklist de Implementación

- [ ] Reemplazar HTML en index.html
- [ ] Agregar JavaScript
- [ ] Actualizar CSS si es necesario
- [ ] Probar en desktop
- [ ] Probar en mobile
- [ ] Probar votación
- [ ] Probar ordenamiento
- [ ] Probar creación de posts
- [ ] Probar compartir
- [ ] Probar responsive design
- [ ] Verificar accesibilidad
- [ ] Optimizar performance

---

## 📞 Soporte

Para preguntas o problemas:
1. Revisar la lógica en `community-redesign.js`
2. Verificar que las APIs estén disponibles
3. Revisar la consola del navegador para errores
4. Verificar que Firebase esté configurado correctamente
