export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      admin_kv: {
        Row: {
          key: string
          val: string
        }
        Insert: {
          key: string
          val: string
        }
        Update: {
          key?: string
          val?: string
        }
        Relationships: []
      }
      admin_settings: {
        Row: {
          key: string
          value_hash: string
        }
        Insert: {
          key: string
          value_hash: string
        }
        Update: {
          key?: string
          value_hash?: string
        }
        Relationships: []
      }
      menu_items: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          ko_name: string | null
          price_usd: number | null
          price_vnd: number | null
          sort_order: number | null
          type: string
          vi_name: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          ko_name?: string | null
          price_usd?: number | null
          price_vnd?: number | null
          sort_order?: number | null
          type: string
          vi_name?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          ko_name?: string | null
          price_usd?: number | null
          price_vnd?: number | null
          sort_order?: number | null
          type?: string
          vi_name?: string | null
        }
        Relationships: []
      }
      notices: {
        Row: {
          author: string | null
          body: string
          created_at: string
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          body: string
          created_at?: string
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          body?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      notification_outbox: {
        Row: {
          attempts: number
          created_at: string
          delivery_cursor: number
          event_type: string
          id: string
          idempotency_key: string
          last_error: string | null
          locked_at: string | null
          payload: Json
          processed_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          delivery_cursor?: number
          event_type: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          locked_at?: string | null
          payload: Json
          processed_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          delivery_cursor?: number
          event_type?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          locked_at?: string | null
          payload?: Json
          processed_at?: string | null
          status?: string
        }
        Relationships: []
      }
      order_custom_items: {
        Row: {
          created_at: string
          id: string
          kind: string
          ko_name: string
          line_usd: number
          line_vnd: number
          order_id: string
          qty: number
          unit_usd: number
          unit_vnd: number
          vi_name: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          ko_name: string
          line_usd?: number
          line_vnd?: number
          order_id: string
          qty?: number
          unit_usd?: number
          unit_vnd?: number
          vi_name?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          ko_name?: string
          line_usd?: number
          line_vnd?: number
          order_id?: string
          qty?: number
          unit_usd?: number
          unit_vnd?: number
          vi_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_custom_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          custom_ko_name: string | null
          custom_vi_name: string | null
          id: string
          is_custom: boolean
          line_usd: number
          line_vnd: number
          menu_item_id: string | null
          order_id: string
          qty: number
          unit_usd: number
          unit_vnd: number
        }
        Insert: {
          custom_ko_name?: string | null
          custom_vi_name?: string | null
          id?: string
          is_custom?: boolean
          line_usd: number
          line_vnd: number
          menu_item_id?: string | null
          order_id: string
          qty: number
          unit_usd: number
          unit_vnd: number
        }
        Update: {
          custom_ko_name?: string | null
          custom_vi_name?: string | null
          id?: string
          is_custom?: boolean
          line_usd?: number
          line_vnd?: number
          menu_item_id?: string | null
          order_id?: string
          qty?: number
          unit_usd?: number
          unit_vnd?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          guide_name: string | null
          id: string
          payment_method: string
          sales_excluded: boolean
          source: string
          status: string
          team_no: string | null
          total_usd: number
          total_vnd: number
        }
        Insert: {
          created_at?: string
          guide_name?: string | null
          id?: string
          payment_method?: string
          sales_excluded?: boolean
          source?: string
          status?: string
          team_no?: string | null
          total_usd: number
          total_vnd: number
        }
        Update: {
          created_at?: string
          guide_name?: string | null
          id?: string
          payment_method?: string
          sales_excluded?: boolean
          source?: string
          status?: string
          team_no?: string | null
          total_usd?: number
          total_vnd?: number
        }
        Relationships: []
      }
      page_access_code: {
        Row: {
          code: string
          id: number
          updated_at: string
        }
        Insert: {
          code: string
          id?: number
          updated_at?: string
        }
        Update: {
          code?: string
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      resv_groups: {
        Row: {
          branch: string
          confirmed: boolean
          confirmed_at: string | null
          confirmed_order_id: string | null
          created_at: string
          guests_count: number
          guide_name: string | null
          id: number
          menu_ko: string | null
          menu_vi: string | null
          note: string | null
          price: number | null
          res_date: string
          res_time: string
        }
        Insert: {
          branch: string
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_order_id?: string | null
          created_at?: string
          guests_count: number
          guide_name?: string | null
          id?: number
          menu_ko?: string | null
          menu_vi?: string | null
          note?: string | null
          price?: number | null
          res_date: string
          res_time: string
        }
        Update: {
          branch?: string
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_order_id?: string | null
          created_at?: string
          guests_count?: number
          guide_name?: string | null
          id?: number
          menu_ko?: string | null
          menu_vi?: string | null
          note?: string | null
          price?: number | null
          res_date?: string
          res_time?: string
        }
        Relationships: []
      }
    }
    Views: {
      v_order_detail: {
        Row: {
          created_at: string | null
          ko_name: string | null
          line_usd: number | null
          line_vnd: number | null
          menu_type: string | null
          order_id: string | null
          order_item_id: string | null
          qty: number | null
          status: string | null
          total_usd: number | null
          total_vnd: number | null
          unit_usd: number | null
          unit_vnd: number | null
          vi_name: string | null
        }
        Relationships: []
      }
      v_order_detail_all: {
        Row: {
          created_at: string | null
          ko_name: string | null
          line_usd: number | null
          line_vnd: number | null
          menu_type: string | null
          order_id: string | null
          order_item_id: string | null
          qty: number | null
          sales_excluded: boolean | null
          status: string | null
          total_usd: number | null
          total_vnd: number | null
          unit_usd: number | null
          unit_vnd: number | null
          vi_name: string | null
        }
        Relationships: []
      }
      v_sales_daily: {
        Row: {
          day: string | null
          order_count: number | null
          total_usd: number | null
          total_vnd: number | null
        }
        Relationships: []
      }
      v_sales_monthly: {
        Row: {
          month: string | null
          order_count: number | null
          total_usd: number | null
          total_vnd: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      app_confirm_reservation: {
        Args: { p_id: number; p_payment_method: string; p_team_no: string }
        Returns: string
      }
      app_create_order: {
        Args: {
          p_created_at: string
          p_guide_name: string
          p_items: Json
          p_payment_method: string
          p_source: string
          p_status: string
          p_team_no: string
        }
        Returns: string
      }
      app_create_reservation: {
        Args: {
          p_branch: string
          p_guests_count: number
          p_guide_name: string
          p_menu_ko: string
          p_menu_vi: string
          p_note: string
          p_price: number
          p_res_date: string
          p_res_time: string
        }
        Returns: number
      }
      app_delete_order: { Args: { p_order_id: string }; Returns: boolean }
      app_delete_reservation: { Args: { p_id: number }; Returns: boolean }
      app_set_sales_excluded: {
        Args: { p_excluded: boolean; p_order_id: string }
        Returns: boolean
      }
      app_unconfirm_reservation: { Args: { p_id: number }; Returns: boolean }
      app_update_and_confirm_reservation: {
        Args: {
          p_branch: string
          p_guests_count: number
          p_guide_name: string
          p_id: number
          p_menu_ko: string
          p_menu_vi: string
          p_note: string
          p_payment_method: string
          p_price: number
          p_res_date: string
          p_res_time: string
          p_team_no: string
        }
        Returns: string
      }
      app_update_order: {
        Args: {
          p_guide_name: string
          p_items: Json
          p_order_id: string
          p_payment_method: string
          p_status: string
          p_team_no: string
        }
        Returns: boolean
      }
      app_update_reservation: {
        Args: {
          p_branch: string
          p_guests_count: number
          p_guide_name: string
          p_id: number
          p_menu_ko: string
          p_menu_vi: string
          p_note: string
          p_price: number
          p_res_date: string
          p_res_time: string
        }
        Returns: number
      }
      current_app_role: { Args: never; Returns: string }
      has_app_role: { Args: { p_allowed_roles: string[] }; Returns: boolean }
      internal_hash_legacy_password: {
        Args: { p_password: string }
        Returns: string
      }
      send_resv_summary_by_date: {
        Args: { p_date: string }
        Returns: undefined
      }
      send_tomorrow_resv_summary: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
