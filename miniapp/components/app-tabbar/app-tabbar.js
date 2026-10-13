Component({
  properties: {
    current: { type: Number, value: 0 }
  },
  data: {
    items: [
      { path: '/pages/index/index', label: '首页', icon: 'home-o' },
      { path: '/pages/menu/menu', label: '菜单', icon: 'shop-o' },
      { path: '/pages/todos/todos', label: '待办', icon: 'todo-list-o' },
      { path: '/pages/apps/apps', label: '应用', icon: 'apps-o' },
      { path: '/pages/profile/profile', label: '我的', icon: 'user-o' }
    ]
  },
  methods: {
    onChange(event) {
      const item = this.data.items[Number(event.detail)]
      if (!item) return

      // This project intentionally uses a Vant custom tabbar instead of the
      // native tabBar (the calendar lives on the home page).  switchTab only
      // works with native tabBar pages, so replace the current page here.
      const pages = getCurrentPages()
      const currentRoute = pages.length ? `/${pages[pages.length - 1].route}` : ''
      if (currentRoute === item.path) return
      wx.redirectTo({ url: item.path })
    }
  }
})
